#pragma once

#include "carrot_impl/address_device_hierarchies.h"
#include "carrot_impl/spend_device.h"
#include <functional>
#include <memory>

namespace rosen_fcmp
{
// Coordinates relative to the legacy account threshold key X = k_s G.
// O = X + x_offset G + y T. Neither field contains k_s.
struct legacy_input_opening
{
    crypto::public_key account_spend_key;
    crypto::public_key onetime_address;
    crypto::secret_key x_offset;
    crypto::secret_key y;
    bool biased_hash_to_point;
};

struct sal_request
{
    crypto::hash message;
    FcmpRerandomizedOutputCompressed rerandomized;
    legacy_input_opening opening;
    crypto::key_image expected_key_image;
};

struct sal_response
{
    crypto::key_image key_image;
    fcmp_pp::FcmpPpSalProof proof;
};

// Local bridge to an existing threshold signer. Authorization owns destination,
// amount, fee, input provenance and durable session policy; no default approval.
// The device owns upstream reconstruction and verification of the resulting SAL.
class threshold_spend_device final : public carrot::spend_device
{
public:
    using key_images = std::unordered_map<crypto::public_key, crypto::key_image>;
    using authorize_callback = std::function<bool(const carrot::CarrotTransactionProposalV1&,
        const crypto::hash&)>;
    using sign_callback = std::function<sal_response(const sal_request&)>;

    threshold_spend_device(std::shared_ptr<const carrot::cryptonote_hierarchy_address_device> address,
        key_images verified_images, authorize_callback authorize, sign_callback sign);

    legacy_input_opening inspect_input(const carrot::OutputOpeningHintVariant&) const;
    // Validate and authorize the exact requests before external threshold nonce
    // creation. This performs no signing and exposes no partially checked set.
    bool prepare_authorized_inputs(const carrot::CarrotTransactionProposalV1&,
        const std::unordered_map<crypto::public_key, FcmpRerandomizedOutputCompressed>&,
        crypto::hash&, std::vector<sal_request>&) const;
    crypto::key_image derive_key_image(const carrot::OutputOpeningHintVariant&) const override;
    crypto::key_image derive_key_image_prescanned(const crypto::secret_key&,
        const crypto::public_key&, const carrot::subaddress_index_extended&, bool) const override;
    bool try_sign_carrot_transaction_proposal_v1(const carrot::CarrotTransactionProposalV1&,
        const std::unordered_map<crypto::public_key, FcmpRerandomizedOutputCompressed>&,
        crypto::hash&, signed_input_set_t&) const override;
    bool try_make_key_image_association_proof(const carrot::OutputOpeningHintVariant&,
        crypto::key_image&, carrot::KeyImageProofVariant&) const override;

private:
    crypto::key_image lookup_image(const crypto::public_key&) const;
    const std::shared_ptr<const carrot::cryptonote_hierarchy_address_device> address_;
    const key_images images_;
    const authorize_callback authorize_;
    const sign_callback sign_;
};
}
