#include "carrot_receipt.h"

#include <algorithm>
#include <cstring>
#include <iterator>
#include <optional>
#include <vector>

#include <boost/optional/optional.hpp>

#include "carrot_core/enote_utils.h"
#include "carrot_core/scan.h"
#include "carrot_impl/format_utils.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "crypto/crypto-ops.h"
#include "crypto/hash.h"
#include "ringct/rctOps.h"

namespace rosen::carrot_receipt
{
namespace
{
constexpr std::array<std::uint8_t, 4> MAGIC{{'R', 'C', 'R', '1'}};
constexpr std::size_t NETWORK_OFFSET = 4;
constexpr std::size_t HIERARCHY_OFFSET = 5;
constexpr std::size_t FLAGS_OFFSET = 6;
constexpr std::size_t RESERVED_OFFSET = 7;
constexpr std::size_t TXID_OFFSET = 8;
constexpr std::size_t OUTPUT_INDEX_OFFSET = 40;
constexpr std::size_t SPEND_KEY_OFFSET = 44;
constexpr std::size_t VIEW_KEY_OFFSET = 76;
constexpr std::size_t PAYMENT_ID_OFFSET = 108;
constexpr std::size_t AMOUNT_OFFSET = 116;
constexpr std::size_t INTENT_OFFSET = 124;
constexpr std::size_t R_OFFSET = 156;
constexpr std::size_t D_OFFSET = 188;
constexpr std::size_t SIGNATURE_OFFSET = 220;
constexpr std::uint8_t SUBADDRESS_FLAG = 1;

static_assert(SIGNATURE_OFFSET + sizeof(crypto::signature) == RECEIPT_V1_SIZE);

struct decoded_receipt
{
    cryptonote::network_type network;
    destination_hierarchy hierarchy;
    carrot::CarrotDestinationV1 destination;
    crypto::hash txid;
    std::uint32_t output_index;
    carrot::xmr_amount amount;
    crypto::hash intent_hash;
    crypto::public_key R;
    crypto::public_key D;
    crypto::signature signature;
};

bool is_supported_network(cryptonote::network_type network) noexcept
{
    return network == cryptonote::MAINNET || network == cryptonote::TESTNET
        || network == cryptonote::STAGENET || network == cryptonote::FAKECHAIN;
}

bool is_supported_hierarchy(destination_hierarchy hierarchy) noexcept
{
    return hierarchy == destination_hierarchy::legacy || hierarchy == destination_hierarchy::carrot;
}

bool is_zero_payment_id(const carrot::payment_id_t &payment_id) noexcept
{
    return std::all_of(std::begin(payment_id.bytes), std::end(payment_id.bytes),
        [](unsigned char value) { return value == 0; });
}

bool is_identity(const crypto::ec_point &point) noexcept
{
    static constexpr std::array<unsigned char, 32> IDENTITY{{1}};
    return std::memcmp(point.data, IDENTITY.data(), IDENTITY.size()) == 0;
}

bool is_valid_destination(const carrot::CarrotDestinationV1 &destination) noexcept
{
    if (!carrot::verify_point_is_in_main_subgroup(destination.address_spend_pubkey)
        || !carrot::verify_point_is_in_main_subgroup(destination.address_view_pubkey)
        || is_identity(destination.address_spend_pubkey)
        || is_identity(destination.address_view_pubkey))
        return false;
    return !destination.is_subaddress || is_zero_payment_id(destination.payment_id);
}

void put_u32_le(receipt_bytes_v1 &bytes, std::size_t offset, std::uint32_t value) noexcept
{
    for (std::size_t i = 0; i < 4; ++i)
        bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}

void put_u64_le(receipt_bytes_v1 &bytes, std::size_t offset, std::uint64_t value) noexcept
{
    for (std::size_t i = 0; i < 8; ++i)
        bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}

std::uint32_t get_u32_le(const receipt_bytes_v1 &bytes, std::size_t offset) noexcept
{
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < 4; ++i)
        value |= static_cast<std::uint32_t>(bytes[offset + i]) << (8 * i);
    return value;
}

std::uint64_t get_u64_le(const receipt_bytes_v1 &bytes, std::size_t offset) noexcept
{
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < 8; ++i)
        value |= static_cast<std::uint64_t>(bytes[offset + i]) << (8 * i);
    return value;
}

template<typename T>
void put_object(receipt_bytes_v1 &bytes, std::size_t offset, const T &value) noexcept
{
    std::memcpy(bytes.data() + offset, &value, sizeof(value));
}

template<typename T>
void get_object(const receipt_bytes_v1 &bytes, std::size_t offset, T &value) noexcept
{
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
}

crypto::hash proof_message(const receipt_bytes_v1 &receipt) noexcept
{
    return crypto::cn_fast_hash(receipt.data(), SIGNATURE_OFFSET);
}

void encode_unsigned_receipt(
    receipt_bytes_v1 &receipt,
    const crypto::hash &txid,
    const receipt_expectation_v1 &expectation,
    const crypto::public_key &R,
    const crypto::public_key &D) noexcept
{
    receipt.fill(0);
    std::copy(MAGIC.begin(), MAGIC.end(), receipt.begin());
    receipt[NETWORK_OFFSET] = static_cast<std::uint8_t>(expectation.network);
    receipt[HIERARCHY_OFFSET] = static_cast<std::uint8_t>(expectation.hierarchy);
    receipt[FLAGS_OFFSET] = expectation.destination.is_subaddress ? SUBADDRESS_FLAG : 0;
    put_object(receipt, TXID_OFFSET, txid);
    put_u32_le(receipt, OUTPUT_INDEX_OFFSET, expectation.output_index);
    put_object(receipt, SPEND_KEY_OFFSET, expectation.destination.address_spend_pubkey);
    put_object(receipt, VIEW_KEY_OFFSET, expectation.destination.address_view_pubkey);
    put_object(receipt, PAYMENT_ID_OFFSET, expectation.destination.payment_id);
    put_u64_le(receipt, AMOUNT_OFFSET, expectation.amount);
    put_object(receipt, INTENT_OFFSET, expectation.intent_hash);
    put_object(receipt, R_OFFSET, R);
    put_object(receipt, D_OFFSET, D);
}

status decode_receipt(const receipt_bytes_v1 &receipt, decoded_receipt &decoded) noexcept
{
    if (!std::equal(MAGIC.begin(), MAGIC.end(), receipt.begin())
        || receipt[RESERVED_OFFSET] != 0
        || (receipt[FLAGS_OFFSET] & ~SUBADDRESS_FLAG) != 0)
        return status::malformed_receipt;

    decoded.network = static_cast<cryptonote::network_type>(receipt[NETWORK_OFFSET]);
    decoded.hierarchy = static_cast<destination_hierarchy>(receipt[HIERARCHY_OFFSET]);
    if (!is_supported_network(decoded.network))
        return status::unsupported_network;
    if (!is_supported_hierarchy(decoded.hierarchy))
        return status::malformed_receipt;

    decoded.destination.is_subaddress = (receipt[FLAGS_OFFSET] & SUBADDRESS_FLAG) != 0;
    get_object(receipt, TXID_OFFSET, decoded.txid);
    decoded.output_index = get_u32_le(receipt, OUTPUT_INDEX_OFFSET);
    get_object(receipt, SPEND_KEY_OFFSET, decoded.destination.address_spend_pubkey);
    get_object(receipt, VIEW_KEY_OFFSET, decoded.destination.address_view_pubkey);
    get_object(receipt, PAYMENT_ID_OFFSET, decoded.destination.payment_id);
    decoded.amount = get_u64_le(receipt, AMOUNT_OFFSET);
    get_object(receipt, INTENT_OFFSET, decoded.intent_hash);
    get_object(receipt, R_OFFSET, decoded.R);
    get_object(receipt, D_OFFSET, decoded.D);
    get_object(receipt, SIGNATURE_OFFSET, decoded.signature);
    return is_valid_destination(decoded.destination) ? status::ok : status::invalid_destination;
}

bool expectations_equal(const decoded_receipt &receipt, const receipt_expectation_v1 &expectation) noexcept
{
    return receipt.network == expectation.network
        && receipt.hierarchy == expectation.hierarchy
        && receipt.destination == expectation.destination
        && receipt.amount == expectation.amount
        && receipt.intent_hash == expectation.intent_hash
        && receipt.output_index == expectation.output_index;
}

status load_two_output_transaction(
    const cryptonote::transaction &tx,
    std::vector<carrot::CarrotEnoteV1> &enotes,
    std::optional<carrot::encrypted_payment_id_t> &encrypted_payment_id) noexcept
{
    if (tx.vout.size() != 2)
        return status::unsupported_output_count;
    if (tx.pruned)
        return status::pruned_transaction_unsupported;
    try
    {
        std::vector<crypto::key_image> key_images;
        carrot::xmr_amount fee = 0;
        if (!carrot::try_load_carrot_from_transaction_v1(tx, enotes, key_images, fee, encrypted_payment_id))
            return status::transaction_parse_failed;
    }
    catch (...)
    {
        return status::transaction_parse_failed;
    }
    return enotes.size() == 2 ? status::ok : status::transaction_parse_failed;
}

status calculate_full_transaction_hash(
    const cryptonote::transaction &tx,
    crypto::hash &txid_out) noexcept
{
    if (tx.pruned)
        return status::pruned_transaction_unsupported;
    try
    {
        return cryptonote::calculate_transaction_hash(tx, txid_out, nullptr)
            ? status::ok : status::transaction_parse_failed;
    }
    catch (...)
    {
        return status::transaction_parse_failed;
    }
}

status verify_ephemeral_binding(
    const carrot::CarrotEnoteV1 &enote,
    const crypto::public_key &R,
    const crypto::public_key &D,
    mx25519_pubkey &shared_key_out) noexcept
{
    if (!carrot::verify_point_is_in_main_subgroup(R) || !carrot::verify_point_is_in_main_subgroup(D)
        || is_identity(R) || is_identity(D))
        return status::proof_failed;

    mx25519_pubkey converted_R{};
    if (edwards_bytes_to_x25519_vartime(
            converted_R.data, reinterpret_cast<const unsigned char *>(R.data)) != 0
        || std::memcmp(&converted_R, &enote.enote_ephemeral_pubkey, sizeof(converted_R)) != 0)
        return status::ephemeral_key_mismatch;

    if (edwards_bytes_to_x25519_vartime(
            shared_key_out.data, reinterpret_cast<const unsigned char *>(D.data)) != 0)
        return status::proof_failed;
    return status::ok;
}

status scan_expected_output(
    const carrot::CarrotEnoteV1 &enote,
    const std::optional<carrot::encrypted_payment_id_t> &encrypted_payment_id,
    const carrot::CarrotDestinationV1 &destination,
    const mx25519_pubkey &shared_key,
    carrot::xmr_amount expected_amount) noexcept
{
    crypto::secret_key sender_extension_g{};
    crypto::secret_key sender_extension_t{};
    crypto::secret_key amount_blinding_factor{};
    carrot::xmr_amount amount = 0;
    carrot::CarrotEnoteType enote_type{};
    if (!carrot::try_scan_carrot_enote_external_sender(
            enote,
            encrypted_payment_id,
            destination,
            shared_key,
            sender_extension_g,
            sender_extension_t,
            amount,
            amount_blinding_factor,
            enote_type,
            /* check_pid */ true))
        return status::output_scan_failed;
    return amount == expected_amount && enote_type == carrot::CarrotEnoteType::PAYMENT
        ? status::ok : status::output_mismatch;
}

boost::optional<crypto::public_key> subaddress_base(const carrot::CarrotDestinationV1 &destination)
{
    return destination.is_subaddress
        ? boost::optional<crypto::public_key>{destination.address_spend_pubkey}
        : boost::none;
}

} // namespace

status make_receipt_v1(
    const cryptonote::transaction &tx,
    const crypto::secret_key &enote_ephemeral_private_key,
    const receipt_expectation_v1 &expectation,
    receipt_bytes_v1 &receipt_out) noexcept
{
    receipt_out.fill(0);
    if (tx.vout.size() != 2)
        return status::unsupported_output_count;
    if (!is_supported_network(expectation.network))
        return status::unsupported_network;
    if (!is_supported_hierarchy(expectation.hierarchy))
        return status::malformed_receipt;
    if (!is_valid_destination(expectation.destination))
        return status::invalid_destination;
    if (sc_check(reinterpret_cast<const unsigned char *>(&enote_ephemeral_private_key)) != 0
        || sc_isnonzero(reinterpret_cast<const unsigned char *>(&enote_ephemeral_private_key)) == 0)
        return status::invalid_ephemeral_scalar;

    crypto::hash txid{};
    const status hash_status = calculate_full_transaction_hash(tx, txid);
    if (hash_status != status::ok)
        return hash_status;

    try
    {
        std::vector<carrot::CarrotEnoteV1> enotes;
        std::optional<carrot::encrypted_payment_id_t> encrypted_payment_id;
        const status load_status = load_two_output_transaction(tx, enotes, encrypted_payment_id);
        if (load_status != status::ok)
            return load_status;
        if (expectation.output_index >= enotes.size())
            return status::output_index_out_of_range;

        const crypto::public_key R = expectation.destination.is_subaddress
            ? rct::rct2pk(rct::scalarmultKey(
                rct::pk2rct(expectation.destination.address_spend_pubkey),
                rct::sk2rct(enote_ephemeral_private_key)))
            : rct::rct2pk(rct::scalarmultBase(rct::sk2rct(enote_ephemeral_private_key)));
        const crypto::public_key D = rct::rct2pk(rct::scalarmultKey(
            rct::pk2rct(expectation.destination.address_view_pubkey),
            rct::sk2rct(enote_ephemeral_private_key)));

        mx25519_pubkey shared_key{};
        status result = verify_ephemeral_binding(enotes[expectation.output_index], R, D, shared_key);
        if (result != status::ok)
            return result;
        result = scan_expected_output(
            enotes[expectation.output_index], encrypted_payment_id,
            expectation.destination, shared_key, expectation.amount);
        if (result != status::ok)
            return result;

        encode_unsigned_receipt(receipt_out, txid, expectation, R, D);
        crypto::signature signature{};
        crypto::generate_tx_proof(
            proof_message(receipt_out),
            R,
            expectation.destination.address_view_pubkey,
            subaddress_base(expectation.destination),
            D,
            enote_ephemeral_private_key,
            signature);
        put_object(receipt_out, SIGNATURE_OFFSET, signature);

        verified_deposit_v1 checked{};
        result = verify_receipt_v1(tx, receipt_out, expectation, checked);
        if (result != status::ok)
            receipt_out.fill(0);
        return result;
    }
    catch (...)
    {
        receipt_out.fill(0);
        return status::internal_error;
    }
}

status verify_receipt_v1(
    const cryptonote::transaction &tx,
    const receipt_bytes_v1 &receipt,
    const receipt_expectation_v1 &expectation,
    verified_deposit_v1 &deposit_out) noexcept
{
    deposit_out = {};
    decoded_receipt decoded{};
    status result = decode_receipt(receipt, decoded);
    if (result != status::ok)
        return result;
    if (!is_supported_network(expectation.network))
        return status::unsupported_network;
    if (!is_supported_hierarchy(expectation.hierarchy) || !is_valid_destination(expectation.destination))
        return status::invalid_destination;
    if (!expectations_equal(decoded, expectation))
        return status::expectation_mismatch;

    try
    {
        crypto::hash actual_txid{};
        result = calculate_full_transaction_hash(tx, actual_txid);
        if (result != status::ok)
            return result;
        if (decoded.txid != actual_txid)
            return status::transaction_mismatch;

        std::vector<carrot::CarrotEnoteV1> enotes;
        std::optional<carrot::encrypted_payment_id_t> encrypted_payment_id;
        result = load_two_output_transaction(tx, enotes, encrypted_payment_id);
        if (result != status::ok)
            return result;
        if (decoded.output_index >= enotes.size())
            return status::output_index_out_of_range;

        mx25519_pubkey shared_key{};
        result = verify_ephemeral_binding(
            enotes[decoded.output_index], decoded.R, decoded.D, shared_key);
        if (result != status::ok)
            return result;
        if (!crypto::check_tx_proof(
                proof_message(receipt),
                decoded.R,
                decoded.destination.address_view_pubkey,
                subaddress_base(decoded.destination),
                decoded.D,
                decoded.signature,
                /* version */ 2))
            return status::proof_failed;
        result = scan_expected_output(
            enotes[decoded.output_index], encrypted_payment_id,
            decoded.destination, shared_key, decoded.amount);
        if (result != status::ok)
            return result;

        deposit_out = {
            decoded.txid,
            decoded.output_index,
            enotes[decoded.output_index].onetime_address,
            decoded.amount,
            decoded.intent_hash,
            decoded.destination,
            decoded.hierarchy,
        };
        return status::ok;
    }
    catch (...)
    {
        deposit_out = {};
        return status::internal_error;
    }
}

const char *status_string(status value) noexcept
{
    switch (value)
    {
        case status::ok: return "ok";
        case status::malformed_receipt: return "malformed receipt";
        case status::unsupported_network: return "unsupported network";
        case status::unsupported_output_count: return "unsupported output count";
        case status::pruned_transaction_unsupported: return "pruned transaction unsupported";
        case status::output_index_out_of_range: return "output index out of range";
        case status::invalid_ephemeral_scalar: return "invalid ephemeral scalar";
        case status::invalid_destination: return "invalid destination";
        case status::transaction_parse_failed: return "transaction parse failed";
        case status::transaction_mismatch: return "transaction mismatch";
        case status::expectation_mismatch: return "expectation mismatch";
        case status::ephemeral_key_mismatch: return "ephemeral key mismatch";
        case status::proof_failed: return "proof failed";
        case status::output_scan_failed: return "output scan failed";
        case status::output_mismatch: return "output mismatch";
        case status::internal_error: return "internal error";
    }
    return "unknown status";
}

} // namespace rosen::carrot_receipt
