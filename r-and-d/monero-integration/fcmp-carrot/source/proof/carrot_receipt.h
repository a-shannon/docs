#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "carrot_core/destination.h"
#include "cryptonote_basic/cryptonote_basic.h"
#include "cryptonote_config.h"
#include "crypto/crypto.h"

namespace rosen::carrot_receipt
{

constexpr std::size_t RECEIPT_V1_SIZE = 284;
using receipt_bytes_v1 = std::array<std::uint8_t, RECEIPT_V1_SIZE>;

enum class destination_hierarchy : std::uint8_t
{
    legacy = 0,
    carrot = 1,
};

enum class status
{
    ok = 0,
    malformed_receipt,
    unsupported_network,
    unsupported_output_count,
    pruned_transaction_unsupported,
    output_index_out_of_range,
    invalid_ephemeral_scalar,
    invalid_destination,
    transaction_parse_failed,
    transaction_mismatch,
    expectation_mismatch,
    ephemeral_key_mismatch,
    proof_failed,
    output_scan_failed,
    output_mismatch,
    internal_error,
};

struct receipt_expectation_v1
{
    cryptonote::network_type network;
    destination_hierarchy hierarchy;
    carrot::CarrotDestinationV1 destination;
    carrot::xmr_amount amount;
    crypto::hash intent_hash;
    std::uint32_t output_index;
};

struct verified_deposit_v1
{
    crypto::hash txid;
    std::uint32_t output_index;
    crypto::public_key output_public_key;
    carrot::xmr_amount amount;
    crypto::hash intent_hash;
    carrot::CarrotDestinationV1 destination;
    destination_hierarchy hierarchy;
};

status make_receipt_v1(
    const cryptonote::transaction &tx,
    const crypto::secret_key &enote_ephemeral_private_key,
    const receipt_expectation_v1 &expectation,
    receipt_bytes_v1 &receipt_out) noexcept;

status verify_receipt_v1(
    const cryptonote::transaction &tx,
    const receipt_bytes_v1 &receipt,
    const receipt_expectation_v1 &expectation,
    verified_deposit_v1 &deposit_out) noexcept;

const char *status_string(status value) noexcept;

} // namespace rosen::carrot_receipt
