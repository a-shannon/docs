#include "threshold_spend_device.h"
#include "carrot_receipt.h"

#include "carrot_core/enote_utils.h"
#include "carrot_impl/address_device_ram_borrowed.h"
#include "carrot_impl/carrot_offchain_serialization.h"
#include "carrot_impl/format_utils.h"
#include "carrot_impl/spend_device_ram_borrowed.h"
#include "carrot_impl/tx_builder_inputs.h"
#include "carrot_impl/tx_builder_outputs.h"
#include "carrot_impl/tx_proposal_utils.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "fcmp_pp/prove.h"
#include "fcmp_pp/tree_cache.h"
#include "wallet/tx_builder.h"
#include "wallet/wallet2.h"
#include "net/http.h"
#include "net/http_client.h"
#include "rpc/core_rpc_server_commands_defs.h"
#include <array>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace
{
using namespace carrot;
using namespace rosen_fcmp;
constexpr xmr_amount input_amount = 1000000000000;
struct fixture_profile
{
    unsigned char spend, view, receiver_spend, receiver_view;
    xmr_amount payment;
};
fixture_profile profile{7, 11, 17, 19, 400000000000};

void require(bool condition, const char* message)
{
    if (!condition) throw std::runtime_error(message);
}

crypto::public_key public_for(unsigned char scalar)
{
    crypto::secret_key secret{};
    to_bytes(secret)[0] = scalar;
    crypto::public_key pub;
    require(crypto::secret_key_to_public_key(secret, pub), "synthetic public key failed");
    return pub;
}

// Known scalars are confined to this disposable interoperability fixture.
// The reusable threshold device has no account secret-key constructor.
crypto::secret_key fixture_spend{{7}};
crypto::secret_key fixture_view{{11}};
crypto::secret_key fixture_receiver_spend{{17}};
crypto::secret_key fixture_receiver_view{{19}};

std::shared_ptr<const cryptonote_hierarchy_address_device> address_device()
{
    return std::make_shared<cryptonote_hierarchy_address_device>(
        std::make_shared<cryptonote_view_incoming_key_ram_borrowed_device>(fixture_view), public_for(profile.spend));
}

std::string read_file(const char* path, std::size_t limit)
{
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    require(bool(file), "cannot open input file");
    const auto size = file.tellg();
    require(size >= 0 && static_cast<std::size_t>(size) <= limit, "input file size exceeds limit");
    file.seekg(0);
    std::string bytes(static_cast<std::size_t>(size), '\0');
    file.read(bytes.data(), bytes.size());
    require(bool(file), "short input read");
    return bytes;
}

void write_file(const char* path, const std::string& bytes)
{
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    require(bool(file), "cannot open output file");
    file.write(bytes.data(), bytes.size());
    file.close();
    require(bool(file), "output write failed");
}

template<class T> void append(std::string& out, const T& value)
{
    out.append(reinterpret_cast<const char*>(&value), sizeof(T));
}

template<class T> T take(const std::string& in, std::size_t& position)
{
    require(position + sizeof(T) <= in.size(), "truncated fixed-byte message");
    T value{};
    std::memcpy(reinterpret_cast<unsigned char*>(&value), in.data() + position, sizeof(T));
    position += sizeof(T);
    return value;
}

std::string encode_request(const sal_request& request)
{
    std::string out(1, '\0'); // mode=legacy-x, independent of output era
    append(out, request.message);
    append(out, request.rerandomized);
    append(out, request.opening.onetime_address);
    append(out, request.opening.account_spend_key);
    append(out, crypto::secret_key{{1}});
    append(out, request.opening.x_offset);
    append(out, request.opening.y);
    append(out, request.expected_key_image);
    require(out.size() == 481, "unexpected request ABI size");
    return out;
}

sal_request decode_request(const std::string& in)
{
    require(in.size() == 481 && in[0] == 0, "unsupported request version or length");
    std::size_t p = 1;
    sal_request request{};
    request.message = take<crypto::hash>(in, p);
    request.rerandomized = take<FcmpRerandomizedOutputCompressed>(in, p);
    request.opening.onetime_address = take<crypto::public_key>(in, p);
    request.opening.account_spend_key = take<crypto::public_key>(in, p);
    require(take<crypto::secret_key>(in, p) == crypto::secret_key{{1}}, "unsupported fixture multiplier");
    request.opening.x_offset = take<crypto::secret_key>(in, p);
    request.opening.y = take<crypto::secret_key>(in, p);
    request.expected_key_image = take<crypto::key_image>(in, p);
    return request;
}

rosen::carrot_receipt::receipt_expectation_v1 receipt_expectation(const crypto::hash& intent,
    std::uint32_t output_index)
{
    return {cryptonote::FAKECHAIN, rosen::carrot_receipt::destination_hierarchy::legacy,
        {public_for(profile.receiver_spend), public_for(profile.receiver_view), false, null_payment_id},
        profile.payment, intent, output_index};
}

crypto::hash read_intent(const char* path)
{
    const auto bytes = read_file(path, 32);
    require(bytes.size() == 32, "intent file must contain exactly 32 bytes");
    std::size_t position = 0;
    return take<crypto::hash>(bytes, position);
}

void verify_receipt_files(const char* transaction_path, const char* receipt_path, const char* intent_path)
{
    namespace receipt = rosen::carrot_receipt;
    const auto tx_bytes = read_file(transaction_path, 2 * 1024 * 1024);
    cryptonote::transaction tx;
    require(cryptonote::parse_and_validate_tx_from_blob(tx_bytes, tx), "invalid transaction for receipt");
    require(cryptonote::tx_to_blob(tx) == tx_bytes, "noncanonical transaction for receipt");
    const auto intent = read_intent(intent_path);
    const auto bytes = read_file(receipt_path, receipt::RECEIPT_V1_SIZE);
    require(bytes.size() == receipt::RECEIPT_V1_SIZE, "wrong receipt size");
    receipt::receipt_bytes_v1 proof;
    std::memcpy(proof.data(), bytes.data(), proof.size());
    require(tx.vout.size() == 2, "receipt fixture requires exactly two outputs");
    std::size_t accepted = 0;
    receipt::verified_deposit_v1 verified;
    for (std::uint32_t i = 0; i < tx.vout.size(); ++i)
    {
        auto expected = receipt_expectation(intent, i);
        receipt::verified_deposit_v1 candidate;
        if (receipt::verify_receipt_v1(tx, proof, expected, candidate) != receipt::status::ok) continue;
        ++accepted;
        verified = candidate;
        // Core transaction copies retain hash caches. An object mutated after
        // a successful lookup must not validate under its previous cached id.
        require(cryptonote::get_transaction_hash(tx) == candidate.txid, "receipt transaction id mismatch");
        auto stale_cached_tx = tx;
        ++stale_cached_tx.unlock_time; // deliberately no invalidate_hashes()
        receipt::verified_deposit_v1 stale_rejected;
        require(receipt::verify_receipt_v1(stale_cached_tx, proof, expected, stale_rejected)
                == receipt::status::transaction_mismatch,
            "receipt accepted a mutated transaction through stale Core hash cache");
        reinterpret_cast<unsigned char*>(&expected.intent_hash)[0] ^= 1;
        receipt::verified_deposit_v1 rejected;
        require(receipt::verify_receipt_v1(tx, proof, expected, rejected) != receipt::status::ok,
            "receipt accepted changed intent");
    }
    require(accepted == 1, "receipt does not establish expected intent, destination and amount");
    std::vector<CarrotEnoteV1> enotes;
    std::vector<crypto::key_image> source_images;
    xmr_amount fee;
    std::optional<encrypted_payment_id_t> pid;
    require(try_load_carrot_from_transaction_v1(tx, enotes, source_images, fee, pid),
        "receiver could not parse CARROT transaction");
    const CarrotOutputOpeningHintV1 receiver_hint{enotes.at(verified.output_index), pid,
        {{0, 0}, AddressDeriveType::PreCarrot}};
    // This is a receiver-derived image from a fixture-only known account. Never
    // accept a sender-provided image as evidence that a deposit remains unspent.
    const spend_device_ram_borrowed receiver(fixture_receiver_spend, fixture_receiver_view);
    const auto receiver_image = receiver.derive_key_image(receiver_hint);
    std::cout << "verified receipt txid=" << verified.txid << " output_index=" << verified.output_index
        << " K_o=" << verified.output_public_key << " amount=" << verified.amount
        << " key_image=" << receiver_image
        << " destination=" << cryptonote::get_account_address_as_str(cryptonote::FAKECHAIN, false,
            cryptonote::account_public_address{verified.destination.address_spend_pubkey,
                verified.destination.address_view_pubkey}) << " intent=" << verified.intent_hash << "\n";
}

OutputOpeningHintVariant make_input(bool carrot_format)
{
    if (carrot_format)
    {
        CarrotPaymentProposalV1 payment{{public_for(profile.spend), public_for(profile.view), false, null_payment_id},
            input_amount, gen_janus_anchor()};
        crypto::key_image source_first_image{};
        const auto image_point = public_for(31);
        std::memcpy(&source_first_image, &image_point, sizeof(source_first_image));
        RCTOutputEnoteProposal output;
        encrypted_payment_id_t pid;
        get_output_proposal_normal_v1(payment, source_first_image, output, pid);
        return CarrotOutputOpeningHintV1{output.enote, pid, {{0, 0}, AddressDeriveType::PreCarrot}};
    }
    const crypto::secret_key sender{{13}};
    crypto::key_derivation derivation;
    require(crypto::generate_key_derivation(public_for(profile.view), sender, derivation), "legacy derivation failed");
    crypto::public_key ota;
    require(crypto::derive_public_key(derivation, 0, public_for(profile.spend), ota), "legacy OTA failed");
    LegacyOutputOpeningHintV1 hint{};
    hint.onetime_address = ota;
    hint.ephemeral_tx_pubkey = public_for(13);
    hint.subaddr_index = {0, 0};
    hint.amount = input_amount;
    hint.amount_blinding_factor = crypto::secret_key{{23}};
    hint.local_output_index = 0;
    return hint;
}

void export_input(const OutputOpeningHintVariant& input, xmr_amount amount, xmr_amount fee_per_weight,
    const char* request_path, const char* proposal_path)
{
    const auto address = address_device();
    const auto ota = onetime_address_ref(input);
    const spend_device_ram_borrowed reference(fixture_spend, fixture_view);
    const auto image = reference.derive_key_image(input);
    CarrotTransactionProposalV1 proposal;
    CarrotPaymentProposalV1 payment{{public_for(profile.receiver_spend), public_for(profile.receiver_view), false, null_payment_id},
        profile.payment, gen_janus_anchor()};
    make_carrot_transaction_proposal_v1_transfer({payment}, {}, fee_per_weight, {},
        [&](const auto&, const auto&, std::size_t, std::size_t, std::vector<CarrotSelectedInput>& inputs)
            { inputs = {{amount, input}}; },
        public_for(profile.spend), {{0, 0}, AddressDeriveType::PreCarrot}, {}, {}, proposal);

    std::vector<RCTOutputEnoteProposal> outputs;
    encrypted_payment_id_t pid;
    get_output_enote_proposals_from_proposal_v1(proposal, nullptr, address.get(), image, outputs, pid);
    const auto rerandomized = generate_rerandomized_inputs_nonrefundable(epee::to_span(outputs),
        epee::to_span(proposal.input_proposals), *address, nullptr, *address);
    crypto::hash message;
    make_signable_tx_hash_from_proposal_v1(proposal, nullptr, address.get(), std::vector<crypto::key_image>{image}, message);
    threshold_spend_device inspect(address, {{ota, image}}, [](const auto&, const auto&) { return false; },
        [](const auto&) -> sal_response { throw std::runtime_error("export must not sign"); });
    const sal_request request{message, rerandomized.at(0), inspect.inspect_input(input), image};
    write_file(request_path, encode_request(request));
    write_file(proposal_path, cryptonote::t_serializable_object_to_blob(proposal));
    std::cout << "exported Core " << (use_biased_hash_to_point(input) ? "legacy" : "CARROT")
        << " input, canonical proposal, request481; fee=" << proposal.fee << "\n";
}

void verify_fixture(const char* request_path, const char* proposal_path, const char* response_path,
    const char* transaction_path, const tools::wallet2* node_wallet = nullptr, const char* intent_path = nullptr)
{
    const auto request_bytes = read_file(request_path, 481);
    const auto request = decode_request(request_bytes);
    const auto proposal_bytes = read_file(proposal_path, 1024 * 1024);
    CarrotTransactionProposalV1 proposal;
    require(cryptonote::t_serializable_object_from_blob(proposal, proposal_bytes), "invalid canonical proposal");
    require(cryptonote::t_serializable_object_to_blob(proposal) == proposal_bytes, "noncanonical proposal encoding");
    const auto response_bytes = read_file(response_path, 416);
    require(response_bytes.size() == 416, "wrong SAL response size");
    std::size_t p = 0;
    sal_response response;
    response.key_image = take<crypto::key_image>(response_bytes, p);
    response.proof.assign(response_bytes.begin() + p, response_bytes.end());

    require(proposal.input_proposals.size() == 1 && proposal.normal_payment_proposals.size() == 1,
        "unexpected fixture proposal shape");
    const auto address = address_device();
    const auto ota = onetime_address_ref(proposal.input_proposals.at(0));
    std::size_t calls = 0;
    const auto authorize = [&](const CarrotTransactionProposalV1& candidate, const crypto::hash& hash) {
        const auto& payment = candidate.normal_payment_proposals.at(0);
        return hash == request.message && payment.amount == profile.payment
            && payment.destination == CarrotDestinationV1{public_for(profile.receiver_spend),
                public_for(profile.receiver_view), false, null_payment_id};
    };
    const auto signer = [&](const sal_request& candidate) {
        require(encode_request(candidate) == request_bytes, "Core signing request differs from exported bytes");
        ++calls;
        return response;
    };
    threshold_spend_device device(address, {{ota, request.expected_key_image}}, authorize, signer);
    std::unordered_map<crypto::public_key, FcmpRerandomizedOutputCompressed> rr{{ota, request.rerandomized}};
    crypto::hash checked_hash;
    carrot::spend_device::signed_input_set_t checked_inputs;
    require(device.try_sign_carrot_transaction_proposal_v1(proposal, rr, checked_hash, checked_inputs),
        "fixture authorization denied");
    require(calls == 1 && checked_inputs.size() == 1, "signing callback count mismatch");

    auto altered_message = request.message;
    reinterpret_cast<unsigned char*>(&altered_message)[0] ^= 1;
    require(!fcmp_pp::verify_sal(altered_message, request.rerandomized.input, response.key_image, response.proof),
        "changed message accepted");
    auto altered_proof = response.proof;
    altered_proof[0] ^= 1;
    require(!fcmp_pp::verify_sal(request.message, request.rerandomized.input, response.key_image, altered_proof),
        "changed proof accepted");
    threshold_spend_device denied(address, {{ota, request.expected_key_image}},
        [](const auto&, const auto&) { return false; }, signer);
    require(!denied.try_sign_carrot_transaction_proposal_v1(proposal, rr, checked_hash, checked_inputs),
        "denied authorization accepted");
    require(calls == 1 && checked_inputs.empty() && checked_hash == crypto::null_hash,
        "denied authorization reached signer or exposed output");
    std::cout << "PASS Core proposal -> threshold SAL -> Core verifier; message/proof/authorization negatives\n";

    if (!transaction_path) return;
    std::vector<RCTOutputEnoteProposal> outputs;
    encrypted_payment_id_t pid;
    get_output_enote_proposals_from_proposal_v1(proposal, nullptr, address.get(), response.key_image, outputs, pid);
    auto trees = fcmp_pp::curve_trees::curve_trees_v1();
    fcmp_pp::curve_trees::TreeCacheV1 cache(trees);
    const auto pair = to_output_pair(proposal.input_proposals.at(0));
    require(cache.register_output(pair), "fixture input registration failed");
    crypto::hash first_block{};
    reinterpret_cast<unsigned char*>(&first_block)[0] = 1;
    cache.sync_block(0, first_block, crypto::null_hash, {{1, {fcmp_pp::UnifiedOutput{0, pair}}}});
    crypto::hash next_block{};
    reinterpret_cast<unsigned char*>(&next_block)[0] = 2;
    cache.sync_block(1, next_block, first_block, {});
    const auto& actual_cache = node_wallet ? node_wallet->get_tree_cache_ref() : cache;
    const auto& actual_trees = node_wallet ? node_wallet->get_curve_trees_ref() : *trees;
    const auto transaction = tools::wallet::finalize_fcmps_and_range_proofs({response.key_image},
        {request.rerandomized}, {pair}, {response.proof}, outputs, pid, proposal.fee, actual_cache, actual_trees);
    require(calculate_signable_fcmp_pp_transaction_hash(transaction) == request.message,
        "final transaction changed authorization hash");
    std::vector<CarrotEnoteV1> parsed_enotes;
    std::vector<crypto::key_image> parsed_images;
    xmr_amount parsed_fee;
    std::optional<encrypted_payment_id_t> parsed_pid;
    require(try_load_carrot_from_transaction_v1(transaction, parsed_enotes, parsed_images, parsed_fee, parsed_pid),
        "Core could not parse finalized CARROT transaction");
    require(parsed_fee == proposal.fee && parsed_images == std::vector<crypto::key_image>{response.key_image},
        "finalized fee or key images differ from authorization");
    const cryptonote_hierarchy_address_device receiver(
        std::make_shared<cryptonote_view_incoming_key_ram_borrowed_device>(fixture_receiver_view), public_for(profile.receiver_spend));
    std::size_t received = 0;
    std::uint32_t payment_index = 0;
    for (std::uint32_t index = 0; index < parsed_enotes.size(); ++index)
    {
        const auto& enote = parsed_enotes.at(index);
        const CarrotOutputOpeningHintV1 hint{enote, parsed_pid, {{0, 0}, AddressDeriveType::PreCarrot}};
        xmr_amount amount;
        crypto::secret_key mask;
        if (try_scan_opening_hint_amount(hint, receiver, nullptr, &receiver, amount, mask))
        {
            require(amount == profile.payment, "recipient scanned wrong amount");
            ++received;
            payment_index = index;
        }
    }
    require(received == 1, "recipient did not scan exactly one payment");
    const auto blob = cryptonote::tx_to_blob(transaction);

    // The interim fixture defaults to the explicit Core signing message as its
    // synthetic intent. Campaigns may provide an independently journaled intent.
    const auto intent = intent_path ? read_intent(intent_path) : request.message;
    std::vector<crypto::secret_key> ephemeral_keys;
    std::vector<std::pair<bool, std::size_t>> output_order;
    get_enote_ephemeral_privkeys_from_proposal_v1(proposal, nullptr, address.get(),
        response.key_image, ephemeral_keys, output_order);
    require(transaction.vout.size() == 2 && ephemeral_keys.size() == 1,
        "receipt fixture requires the upstream two-output shared sender key");
    namespace receipt = rosen::carrot_receipt;
    const auto expected = receipt_expectation(intent, payment_index);
    receipt::receipt_bytes_v1 proof;
    const auto made = receipt::make_receipt_v1(transaction, ephemeral_keys.front(), expected, proof);
    require(made == receipt::status::ok, receipt::status_string(made));
    cryptonote::transaction independent_tx;
    require(cryptonote::parse_and_validate_tx_from_blob(blob, independent_tx), "receipt tx reparse failed");
    receipt::verified_deposit_v1 verified;
    const auto checked = receipt::verify_receipt_v1(independent_tx, proof, expected, verified);
    require(checked == receipt::status::ok, receipt::status_string(checked));
    const std::string receipt_path = std::string(transaction_path) + ".receipt";
    const std::string stored_intent_path = std::string(transaction_path) + ".intent";
    write_file(receipt_path.c_str(), std::string(reinterpret_cast<const char*>(proof.data()), proof.size()));
    write_file(stored_intent_path.c_str(), std::string(reinterpret_cast<const char*>(&intent), sizeof(intent)));
    // Transaction publication to disk is last: no submit candidate is emitted
    // when construction, verification or receipt persistence failed.
    write_file(transaction_path, blob);
    verify_receipt_files(transaction_path, receipt_path.c_str(), stored_intent_path.c_str());
    std::cout << "receipt retained; intent_source=" << (intent_path ? "explicit_file" : "synthetic_signable_hash") << "\n";
    std::cout << "PASS Core membership/range finalizer, txid=" << cryptonote::get_transaction_hash(transaction)
        << ", bytes=" << blob.size() << ", recipient=" << profile.payment
        << (node_wallet ? "; node tree, awaiting submission\n" : "; synthetic tree, not node acceptance\n");
}

void require_loopback(const std::string& url)
{
    // No DNS names or user-info/path components; this executable only exercises
    // a disposable loopback daemon selected by the local campaign controller.
    const std::string prefix = "http://127.0.0.1:";
    require(url.compare(0, prefix.size(), prefix) == 0, "fixture RPC must use IPv4 loopback");
    const auto port = url.substr(prefix.size());
    require(!port.empty() && port.size() <= 5 && port.find_first_not_of("0123456789") == std::string::npos,
        "invalid loopback RPC port");
    require(std::stoul(port) > 0 && std::stoul(port) <= 65535, "loopback port out of range");
}

void require_fixture_node(const char* url)
{
    require_loopback(url);
    net::http::client client;
    require(client.set_server(url, boost::none), "could not initialize fixture identity client");
    cryptonote::COMMAND_RPC_GET_INFO::request request;
    cryptonote::COMMAND_RPC_GET_INFO::response response;
    require(epee::net_utils::invoke_http_json("/get_info", request, response, client,
        std::chrono::seconds(30)), "fixture identity RPC transport failed");
    require(response.status == CORE_RPC_STATUS_OK && response.nettype == "fakechain"
        && !response.mainnet && response.offline && response.incoming_connections_count == 0
        && response.outgoing_connections_count == 0, "isolated offline fakechain required");
}

void audit_final(const char* request_path, const char* proposal_path, const char* response_path,
    const char* transaction_path, const char* receipt_path, const char* intent_path)
{
    // Reuse the adapter admission checks with the supplied, already completed
    // response. With no transaction output path this does not construct proofs.
    verify_fixture(request_path, proposal_path, response_path, nullptr);
    const auto request = decode_request(read_file(request_path, 481));
    const auto proposal_bytes = read_file(proposal_path, 1024 * 1024);
    CarrotTransactionProposalV1 proposal;
    require(cryptonote::t_serializable_object_from_blob(proposal, proposal_bytes), "invalid approved proposal");
    const auto response_bytes = read_file(response_path, 416);
    require(response_bytes.size() == 416, "wrong completed response size");
    const fcmp_pp::FcmpPpSalProof approved_sal(response_bytes.begin() + 32, response_bytes.end());
    const auto tx_bytes = read_file(transaction_path, 2 * 1024 * 1024);
    cryptonote::transaction tx;
    require(cryptonote::parse_and_validate_tx_from_blob(tx_bytes, tx), "invalid final transaction");
    require(cryptonote::tx_to_blob(tx) == tx_bytes && !tx.pruned, "final transaction is noncanonical or pruned");
    require(calculate_signable_fcmp_pp_transaction_hash(tx) == request.message,
        "stored transaction signable hash differs from approved request");

    cryptonote::transaction expected_body;
    const auto address = address_device();
    make_pruned_transaction_from_proposal_v1(proposal, nullptr, address.get(),
        std::vector<crypto::key_image>{request.expected_key_image}, expected_body);
    const auto serialize_body = [](cryptonote::transaction& transaction) {
        std::stringstream stream;
        binary_archive<true> archive(stream);
        require(transaction.serialize_base(archive), "transaction base serialization failed");
        return stream.str();
    };
    require(serialize_body(tx) == serialize_body(expected_body),
        "stored transaction body, fee, outputs or images differ from approved Core proposal");

    std::vector<crypto::ec_point> pseudo_outs;
    for (const auto& point : tx.rct_signatures.p.pseudoOuts) pseudo_outs.push_back(rct::rct2pt(point));
    fcmp_pp::FcmpMembershipProof membership;
    std::vector<fcmp_pp::FcmpPpSalProof> actual_sals;
    std::vector<FcmpInputCompressed> actual_inputs;
    fcmp_pp::fcmp_pp_parts_from_proof_v1(tx.rct_signatures.p.fcmp_pp, pseudo_outs,
        tx.rct_signatures.p.n_tree_layers, membership, actual_sals, actual_inputs);
    require(actual_sals.size() == 1 && actual_inputs.size() == 1 && !membership.empty(),
        "stored proof is missing approved input, SAL or membership bytes");
    require(actual_sals.front() == approved_sal, "stored SAL differs from completed threshold response");
    require(std::memcmp(&actual_inputs.front(), &request.rerandomized.input, sizeof(FcmpInputCompressed)) == 0,
        "stored rerandomized input differs from approved request");
    require(fcmp_pp::verify_sal(request.message, actual_inputs.front(), request.expected_key_image,
        actual_sals.front()), "stored SAL failed pinned Core verifier");
    verify_receipt_files(transaction_path, receipt_path, intent_path);
    std::cout << "PASS audit-final stored transaction body/SAL/receipt; txid="
        << cryptonote::get_transaction_hash(tx) << " bytes=" << tx_bytes.size() << "\n";
}

std::unique_ptr<tools::wallet2> node_wallet(const char* url)
{
    require_fixture_node(url);
    auto wallet = std::make_unique<tools::wallet2>(cryptonote::FAKECHAIN, 1, true);
    const cryptonote::account_public_address address{public_for(profile.spend), public_for(profile.view)};
    wallet->generate("", epee::wipeable_string{}, address, fixture_view);
    wallet->get_account().set_createtime(0);
    // The upstream regtest daemon activates HF18 at height1, whereas wallet2
    // otherwise checks mainnet activation heights even for FAKECHAIN. This is
    // the same explicit option used by upstream functional_tests_rpc.py.
    wallet->allow_mismatched_daemon_version(true);
    wallet->set_refresh_from_block_height(0);
    require(wallet->init(url), "failed to initialize loopback wallet RPC");
    wallet->refresh(true);
    std::cout << "view-only wallet refreshed height=" << wallet->get_blockchain_current_height() << "\n";
    return wallet;
}

void authorize_request(const char* request_path, const char* proposal_path)
{
    const auto bytes = read_file(request_path, 481);
    const auto request = decode_request(bytes);
    const auto proposal_bytes = read_file(proposal_path, 1024 * 1024);
    CarrotTransactionProposalV1 proposal;
    require(cryptonote::t_serializable_object_from_blob(proposal, proposal_bytes)
        && cryptonote::t_serializable_object_to_blob(proposal) == proposal_bytes,
        "invalid canonical authorization proposal");
    require(proposal.input_proposals.size() == 1 && proposal.normal_payment_proposals.size() == 1,
        "unsupported authorization proposal shape");
    const auto ota = onetime_address_ref(proposal.input_proposals.front());
    const auto authorize = [&](const CarrotTransactionProposalV1& candidate, const crypto::hash& hash) {
        const auto& payment = candidate.normal_payment_proposals.front();
        return hash == request.message && payment.amount == profile.payment
            && payment.destination == CarrotDestinationV1{public_for(profile.receiver_spend),
                public_for(profile.receiver_view), false, null_payment_id};
    };
    threshold_spend_device device(address_device(), {{ota, request.expected_key_image}}, authorize,
        [](const auto&) -> sal_response { throw std::runtime_error("authorize-only must never sign"); });
    crypto::hash hash;
    std::vector<sal_request> prepared;
    require(device.prepare_authorized_inputs(proposal, {{ota, request.rerandomized}}, hash, prepared),
        "pre-sign proposal authorization denied");
    require(prepared.size() == 1 && encode_request(prepared.front()) == bytes,
        "pre-sign request differs from reconstructed Core proposal");
    std::cout << "PASS Core pre-sign authorization exact request; message=" << hash << "\n";
}

void node_export(const char* url, bool carrot_format, const char* request_path, const char* proposal_path,
    const char* input_key = nullptr)
{
    crypto::public_key selected{};
    if (input_key)
        require(std::strlen(input_key) == 64 && epee::string_tools::hex_to_pod(input_key, selected)
            && epee::string_tools::pod_to_hex(selected) == input_key, "noncanonical selected input key");
    auto wallet = node_wallet(url);
    tools::wallet2::transfer_container transfers;
    wallet->get_transfers(transfers);
    net::http::client client;
    require(client.set_server(url, boost::none), "could not initialize spent-image RPC client");
    const spend_device_ram_borrowed image_device(fixture_spend, fixture_view);
    for (const auto& transfer : transfers)
    {
        if (transfer.m_spent || transfer.m_frozen || !wallet->is_transfer_unlocked(transfer)
            || transfer.amount() <= profile.payment || transfer.m_subaddr_index != cryptonote::subaddress_index{0, 0})
            continue;
        const auto hint = tools::wallet::make_sal_opening_hint_from_transfer_details(transfer);
        if (input_key && onetime_address_ref(hint) != selected) continue;
        if ((!use_biased_hash_to_point(hint)) != carrot_format) continue;
        fcmp_pp::curve_trees::CurveTreesV1::Path path;
        if (!wallet->get_tree_cache_ref().get_output_path(to_output_pair(hint), path) || path.empty()) continue;
        const auto image = image_device.derive_key_image(hint);
        cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::request spent_request;
        spent_request.key_images = {epee::string_tools::pod_to_hex(image)};
        cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::response spent_response;
        require(epee::net_utils::invoke_http_json("/is_key_image_spent", spent_request, spent_response, client,
            std::chrono::seconds(30)), "spent-image RPC transport failed");
        require(spent_response.status == CORE_RPC_STATUS_OK && spent_response.spent_status.size() == 1,
            "invalid spent-image RPC response");
        const auto spent_status = spent_response.spent_status.front();
        require(spent_status == cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::UNSPENT
            || spent_status == cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::SPENT_IN_BLOCKCHAIN
            || spent_status == cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::SPENT_IN_POOL,
            "unknown spent-image status");
        if (spent_status != cryptonote::COMMAND_RPC_IS_KEY_IMAGE_SPENT::UNSPENT) continue;
        export_input(hint, transfer.amount(), wallet->get_base_fee(), request_path, proposal_path);
        return;
    }
    throw std::runtime_error("no mature scanned input of requested era with a current membership path");
}

void node_submit(const char* url, const char* transaction_path)
{
    require_fixture_node(url);
    const std::string receipt_path = std::string(transaction_path) + ".receipt";
    const std::string intent_path = std::string(transaction_path) + ".intent";
    verify_receipt_files(transaction_path, receipt_path.c_str(), intent_path.c_str());
    const auto bytes = read_file(transaction_path, 2 * 1024 * 1024);
    cryptonote::transaction tx;
    require(cryptonote::parse_and_validate_tx_from_blob(bytes, tx), "invalid serialized transaction");
    require(cryptonote::tx_to_blob(tx) == bytes, "noncanonical transaction bytes");
    cryptonote::COMMAND_RPC_SEND_RAW_TX::request request;
    request.tx_as_hex = epee::string_tools::buff_to_hex_nodelimer(bytes);
    request.do_not_relay = false;
    request.do_sanity_checks = true;
    cryptonote::COMMAND_RPC_SEND_RAW_TX::response response;
    net::http::client client;
    require(client.set_server(url, boost::none), "could not initialize loopback client");
    require(epee::net_utils::invoke_http_json("/sendrawtransaction", request, response, client,
        std::chrono::seconds(120)), "transaction submission transport failed");
    require(response.status == CORE_RPC_STATUS_OK, response.reason.c_str());
    std::cout << "node accepted txid=" << cryptonote::get_transaction_hash(tx) << "\n";
}
}

int main(int argc, char** argv)
{
    try
    {
        if (argc > 1 && std::string(argv[1]) == "return")
        {
            profile.payment = 100000000000;
            --argc;
            ++argv;
        }
        else if (argc > 1 && std::string(argv[1]) == "user")
        {
            profile = {17, 19, 7, 11, 200000000000};
            fixture_spend = crypto::secret_key{{17}};
            fixture_view = crypto::secret_key{{19}};
            fixture_receiver_spend = crypto::secret_key{{7}};
            fixture_receiver_view = crypto::secret_key{{11}};
            --argc;
            ++argv;
        }
        if (argc == 5 && std::string(argv[1]) == "export")
        {
            const std::string kind = argv[2];
            require(kind == "legacy" || kind == "carrot", "unknown input format");
            export_input(make_input(kind == "carrot"), input_amount, 100, argv[3], argv[4]);
        }
        else if ((argc >= 5 && argc <= 7) && std::string(argv[1]) == "verify")
            verify_fixture(argv[2], argv[3], argv[4], argc >= 6 ? argv[5] : nullptr,
                nullptr, argc == 7 ? argv[6] : nullptr);
        else if (argc == 4 && std::string(argv[1]) == "authorize")
            authorize_request(argv[2], argv[3]);
        else if ((argc == 6 || argc == 7) && std::string(argv[1]) == "node-export")
        {
            const std::string kind = argv[3];
            require(kind == "legacy" || kind == "carrot", "unknown input format");
            node_export(argv[2], kind == "carrot", argv[4], argv[5], argc == 7 ? argv[6] : nullptr);
        }
        else if ((argc == 7 || argc == 8) && std::string(argv[1]) == "node-verify")
        {
            auto wallet = node_wallet(argv[2]);
            verify_fixture(argv[3], argv[4], argv[5], argv[6], wallet.get(), argc == 8 ? argv[7] : nullptr);
        }
        else if (argc == 5 && std::string(argv[1]) == "verify-receipt")
            verify_receipt_files(argv[2], argv[3], argv[4]);
        else if (argc == 8 && std::string(argv[1]) == "audit-final")
            audit_final(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7]);
        else if (argc == 4 && std::string(argv[1]) == "node-submit") node_submit(argv[2], argv[3]);
        else if (argc == 2 && std::string(argv[1]) == "addresses")
        {
            std::cout << (profile.spend == 7 ? "vault=" : "user=") << cryptonote::get_account_address_as_str(cryptonote::FAKECHAIN, false,
                cryptonote::account_public_address{public_for(profile.spend), public_for(profile.view)}) << "\n";
            std::cout << "receiver=" << cryptonote::get_account_address_as_str(cryptonote::FAKECHAIN, false,
                cryptonote::account_public_address{public_for(profile.receiver_spend), public_for(profile.receiver_view)}) << "\n";
        }
        else throw std::runtime_error("usage: [user|return] export legacy|carrot REQUEST PROPOSAL; [user|return] authorize REQUEST PROPOSAL; [user|return] verify REQUEST PROPOSAL RESPONSE [TX [INTENT]]; [user|return] node-export URL legacy|carrot REQUEST PROPOSAL [INPUT_KO]; [user|return] node-verify URL REQUEST PROPOSAL RESPONSE TX [INTENT]; [user|return] verify-receipt TX RECEIPT INTENT; [user|return] audit-final REQUEST PROPOSAL RESPONSE TX RECEIPT INTENT; [user|return] node-submit URL TX; [user|return] addresses");
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
