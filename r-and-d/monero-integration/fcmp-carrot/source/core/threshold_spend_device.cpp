#include "threshold_spend_device.h"

#include "carrot_impl/tx_builder_inputs.h"
#include "carrot_impl/tx_builder_outputs.h"
#include "fcmp_pp/prove.h"
#include "crypto/generators.h"
#include "ringct/rctOps.h"
#include <boost/multiprecision/cpp_int.hpp>
#include <set>
#include <stdexcept>

namespace rosen_fcmp
{
namespace
{
void require(bool condition, const char* message)
{
    if (!condition) throw std::runtime_error(message);
}
}

threshold_spend_device::threshold_spend_device(
    std::shared_ptr<const carrot::cryptonote_hierarchy_address_device> address,
    key_images verified_images, authorize_callback authorize, sign_callback sign)
    : address_(std::move(address)), images_(std::move(verified_images)),
      authorize_(std::move(authorize)), sign_(std::move(sign))
{
    require(bool(address_) && bool(authorize_) && bool(sign_), "missing threshold device callback");
    std::set<crypto::key_image> unique_images;
    for (const auto& item : images_)
    {
        require(crypto::check_key(item.first), "invalid input one-time address");
        require(unique_images.insert(item.second).second, "duplicate precomputed key image");
    }
}

legacy_input_opening threshold_spend_device::inspect_input(
    const carrot::OutputOpeningHintVariant& hint) const
{
    const auto index = carrot::subaddress_index_ref(hint);
    require(address_->supports_address_derive_type(index.derive_type), "unsupported account key hierarchy");
    legacy_input_opening result{};
    result.onetime_address = carrot::onetime_address_ref(hint);
    result.biased_hash_to_point = carrot::use_biased_hash_to_point(hint);
    address_->get_address_spend_pubkey({{0, 0}, carrot::AddressDeriveType::PreCarrot},
        result.account_spend_key);

    crypto::secret_key sender_g, address_g, multiplier;
    require(carrot::try_scan_opening_hint_sender_extensions(hint, *address_, nullptr,
        address_.get(), sender_g, result.y), "input opening failed upstream scan");
    address_->get_address_openings(index, address_g, multiplier);
    require(multiplier == crypto::secret_key{{1}}, "legacy account scalar must equal one");
    sc_add(to_bytes(result.x_offset), to_bytes(sender_g), to_bytes(address_g));

    const rct::key reconstructed = rct::addKeys(rct::pk2rct(result.account_spend_key),
        rct::addKeys(rct::scalarmultBase(rct::sk2rct(result.x_offset)),
            rct::scalarmultKey(rct::pk2rct(crypto::get_T()), rct::sk2rct(result.y))));
    require(reconstructed == rct::pk2rct(result.onetime_address), "input does not open under threshold account");
    return result;
}

crypto::key_image threshold_spend_device::lookup_image(const crypto::public_key& ota) const
{
    const auto it = images_.find(ota);
    require(it != images_.end(), "missing verified precomputed key image");
    return it->second;
}

crypto::key_image threshold_spend_device::derive_key_image(const carrot::OutputOpeningHintVariant& hint) const
{
    return lookup_image(inspect_input(hint).onetime_address);
}

crypto::key_image threshold_spend_device::derive_key_image_prescanned(const crypto::secret_key&,
    const crypto::public_key& ota, const carrot::subaddress_index_extended& index, bool) const
{
    // The upstream interface requires the caller to have scanned this input.
    require(address_->supports_address_derive_type(index.derive_type), "unsupported account key hierarchy");
    return lookup_image(ota);
}

bool threshold_spend_device::prepare_authorized_inputs(
    const carrot::CarrotTransactionProposalV1& proposal,
    const std::unordered_map<crypto::public_key, FcmpRerandomizedOutputCompressed>& rerandomized,
    crypto::hash& hash_out, std::vector<sal_request>& requests_out) const
{
    hash_out = crypto::null_hash;
    requests_out.clear();
    require(!proposal.input_proposals.empty(), "empty transaction proposal");
    require(rerandomized.size() == proposal.input_proposals.size(), "rerandomized input count mismatch");
    // The pinned upstream finalizer has no arbitrary-extra argument. Reject it
    // here rather than sign a hash that its final transaction cannot reproduce.
    require(proposal.extra.empty(), "extra payload is unsupported by this finalizer");

    boost::multiprecision::uint128_t input_amount = 0;
    boost::multiprecision::uint128_t output_amount = proposal.fee;
    std::set<crypto::public_key> unique_inputs;
    for (const auto& hint : proposal.input_proposals)
    {
        require(unique_inputs.insert(carrot::onetime_address_ref(hint)).second, "duplicate proposal input");
        const auto& rr = rerandomized.at(carrot::onetime_address_ref(hint));
        require(carrot::verify_rerandomized_output_basic(rr, carrot::onetime_address_ref(hint),
            carrot::amount_commitment_ref(hint), carrot::use_biased_hash_to_point(hint)),
            "rerandomized input does not match opening hint");
        carrot::xmr_amount amount;
        crypto::secret_key mask;
        require(carrot::try_scan_opening_hint_amount(hint, *address_, nullptr, address_.get(), amount, mask),
            "input amount failed upstream scan");
        input_amount += amount;
    }
    for (const auto& payment : proposal.normal_payment_proposals) output_amount += payment.amount;
    for (const auto& payment : proposal.selfsend_payment_proposals)
    {
        crypto::public_key owned_address;
        address_->get_address_spend_pubkey(payment.subaddr_index, owned_address);
        require(owned_address == payment.destination_address_spend_pubkey, "change address does not belong to vault");
        output_amount += payment.amount;
    }
    require(input_amount == output_amount, "proposal amounts and fee do not balance");

    std::vector<crypto::key_image> sorted_images;
    carrot::get_sorted_input_key_images_from_proposal_v1(proposal, *this, sorted_images);
    crypto::hash message;
    carrot::make_signable_tx_hash_from_proposal_v1(proposal, nullptr, address_.get(), sorted_images, message);
    if (!authorize_(proposal, message)) return false;

    std::vector<sal_request> result;
    for (const auto& hint : proposal.input_proposals)
    {
        const auto opening = inspect_input(hint);
        const auto image = lookup_image(opening.onetime_address);
        result.push_back({message, rerandomized.at(opening.onetime_address), opening, image});
    }
    hash_out = message;
    requests_out = std::move(result);
    return true;
}

bool threshold_spend_device::try_sign_carrot_transaction_proposal_v1(
    const carrot::CarrotTransactionProposalV1& proposal,
    const std::unordered_map<crypto::public_key, FcmpRerandomizedOutputCompressed>& rerandomized,
    crypto::hash& hash_out, signed_input_set_t& signed_out) const
{
    hash_out = crypto::null_hash;
    signed_out.clear();
    crypto::hash message;
    std::vector<sal_request> requests;
    if (!prepare_authorized_inputs(proposal, rerandomized, message, requests)) return false;
    signed_input_set_t result;
    for (const auto& request : requests)
    {
        const auto& image = request.expected_key_image;
        const sal_response response = sign_(request);
        require(response.key_image == image, "threshold signer returned a different key image");
        require(fcmp_pp::verify_sal(message, request.rerandomized.input, image, response.proof),
            "threshold SAL failed pinned upstream verification");
        require(result.emplace(image, std::make_pair(request.opening.onetime_address, response.proof)).second,
            "duplicate signed input");
    }
    hash_out = message;
    signed_out = std::move(result);
    return true;
}

bool threshold_spend_device::try_make_key_image_association_proof(
    const carrot::OutputOpeningHintVariant&, crypto::key_image& image, carrot::KeyImageProofVariant&) const
{
    image = crypto::key_image{};
    throw std::runtime_error("threshold key-image association proof is not implemented");
}
}
