#include "carrot_receipt.h"

#include <cstring>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>

#include <boost/numeric/conversion/cast.hpp>

#include "carrot_core/enote_utils.h"
#include "carrot_core/payment_proposal.h"
#include "carrot_impl/tx_builder_outputs.h"
#include "carrot_impl/tx_proposal_utils.h"
#include "carrot_mock_helpers.h"
#include "crypto/crypto-ops.h"

namespace
{
using namespace rosen::carrot_receipt;

struct fixture
{
    cryptonote::transaction tx;
    crypto::secret_key d_e;
    receipt_expectation_v1 expectation;
};

bool check(bool condition, const char *expression, int line)
{
    if (!condition)
        std::cerr << "line " << line << ": check failed: " << expression << '\n';
    return condition;
}

#define CHECK(expression) do { if (!check((expression), #expression, __LINE__)) return false; } while (false)

fixture make_fixture(destination_hierarchy hierarchy, bool subaddress, bool integrated)
{
    using namespace carrot;
    using namespace carrot::mock;
    using namespace carrot::mock::people;

    payment_id_t payment_id = null_payment_id;
    if (integrated)
        payment_id.bytes[0] = 0x42;

    CarrotDestinationV1 destination;
    if (subaddress)
        destination = bob.subaddress(gen_subaddress_index_extended(AddressDeriveType::Carrot));
    else
        destination = bob.cryptonote_address(payment_id,
            hierarchy == destination_hierarchy::legacy ? AddressDeriveType::PreCarrot : AddressDeriveType::Carrot);

    constexpr xmr_amount amount = 12'345'678;
    const CarrotPaymentProposalV1 payment{destination, amount, gen_janus_anchor()};

    select_inputs_func_t select_inputs = [](
        const boost::multiprecision::uint128_t &nominal_output_sum,
        const std::map<std::size_t, xmr_amount> &fees,
        std::size_t,
        std::size_t,
        std::vector<CarrotSelectedInput> &selected)
    {
        const auto input_amount = boost::numeric_cast<xmr_amount>(nominal_output_sum + fees.at(1));
        selected = {{input_amount, CarrotOutputOpeningHintV1{gen_carrot_enote_v1()}}};
    };

    CarrotTransactionProposalV1 proposal;
    make_carrot_transaction_proposal_v1_transfer(
        {payment},
        {},
        /* fee_per_weight */ 1,
        {},
        std::move(select_inputs),
        alice.carrot_account_spend_pubkey,
        {{0, 0}, AddressDeriveType::Carrot},
        {},
        {},
        proposal);

    std::vector<crypto::key_image> input_key_images{gen_key_image()};
    std::vector<crypto::secret_key> ephemeral_private_keys;
    std::vector<std::pair<bool, std::size_t>> payment_order;
    get_enote_ephemeral_privkeys_from_proposal_v1(
        proposal,
        &alice.s_view_balance_dev,
        &alice.k_view_incoming_dev,
        input_key_images.front(),
        ephemeral_private_keys,
        payment_order);
    if (ephemeral_private_keys.size() != 1)
        throw std::runtime_error("two-output proposal did not produce one shared d_e");
    if (sc_check(reinterpret_cast<const unsigned char *>(&ephemeral_private_keys.front())) != 0
        || sc_isnonzero(reinterpret_cast<const unsigned char *>(&ephemeral_private_keys.front())) == 0)
        throw std::runtime_error("Core proposal builder produced a noncanonical or zero d_e");

    cryptonote::transaction tx;
    make_pruned_transaction_from_proposal_v1(
        proposal,
        &alice.s_view_balance_dev,
        &alice.k_view_incoming_dev,
        input_key_images,
        tx);

    receipt_expectation_v1 expectation{
        cryptonote::FAKECHAIN,
        hierarchy,
        destination,
        amount,
        crypto::rand<crypto::hash>(),
        0,
    };

    return {std::move(tx), ephemeral_private_keys.front(), expectation};
}

bool rejects_pruned_transaction(destination_hierarchy hierarchy, bool subaddress, bool integrated)
{
    fixture f = make_fixture(hierarchy, subaddress, integrated);
    CHECK(f.tx.pruned);
    receipt_bytes_v1 receipt{};
    CHECK(make_receipt_v1(f.tx, f.d_e, f.expectation, receipt) == status::pruned_transaction_unsupported);
    return true;
}

bool rejects_noncanonical_scalar()
{
    fixture f = make_fixture(destination_hierarchy::carrot, false, false);
    crypto::secret_key invalid{};
    std::memset(invalid.data, 0xff, sizeof(invalid.data));
    receipt_bytes_v1 receipt{};
    CHECK(make_receipt_v1(f.tx, invalid, f.expectation, receipt) == status::invalid_ephemeral_scalar);
    return true;
}

bool rejects_more_than_two_outputs()
{
    using namespace carrot;
    using namespace carrot::mock;
    using namespace carrot::mock::people;

    const CarrotPaymentProposalV1 p1{bob.cryptonote_address(), 1000, gen_janus_anchor()};
    const CarrotPaymentProposalV1 p2{bob.cryptonote_address(), 2000, gen_janus_anchor()};
    select_inputs_func_t select_inputs = [](
        const boost::multiprecision::uint128_t &nominal_output_sum,
        const std::map<std::size_t, xmr_amount> &fees,
        std::size_t,
        std::size_t,
        std::vector<CarrotSelectedInput> &selected)
    {
        const auto input_amount = boost::numeric_cast<xmr_amount>(nominal_output_sum + fees.at(1));
        selected = {{input_amount, CarrotOutputOpeningHintV1{gen_carrot_enote_v1()}}};
    };
    CarrotTransactionProposalV1 proposal;
    make_carrot_transaction_proposal_v1_transfer(
        {p1, p2}, {}, 1, {}, std::move(select_inputs), alice.carrot_account_spend_pubkey,
        {{0, 0}, AddressDeriveType::Carrot}, {}, {}, proposal);
    std::vector<crypto::key_image> key_images{gen_key_image()};
    std::vector<crypto::secret_key> keys;
    std::vector<std::pair<bool, std::size_t>> order;
    get_enote_ephemeral_privkeys_from_proposal_v1(
        proposal, &alice.s_view_balance_dev, &alice.k_view_incoming_dev,
        key_images.front(), keys, order);
    cryptonote::transaction tx;
    make_pruned_transaction_from_proposal_v1(
        proposal, &alice.s_view_balance_dev, &alice.k_view_incoming_dev, key_images, tx);
    CHECK(tx.vout.size() == 3);
    receipt_expectation_v1 expectation{
        cryptonote::FAKECHAIN, destination_hierarchy::carrot, p1.destination,
        p1.amount, crypto::rand<crypto::hash>(), 0};
    receipt_bytes_v1 receipt{};
    CHECK(make_receipt_v1(tx, keys.front(), expectation, receipt) == status::unsupported_output_count);
    return true;
}

} // namespace

int main()
{
    try
    {
        if (!rejects_pruned_transaction(destination_hierarchy::legacy, false, true))
            return 1;
        if (!rejects_pruned_transaction(destination_hierarchy::carrot, true, false))
            return 1;
        if (!rejects_noncanonical_scalar())
            return 1;
        if (!rejects_more_than_two_outputs())
            return 1;
    }
    catch (const std::exception &e)
    {
        std::cerr << "unexpected exception: " << e.what() << '\n';
        return 1;
    }
    std::cout << "carrot receipt tests passed\n";
    return 0;
}
