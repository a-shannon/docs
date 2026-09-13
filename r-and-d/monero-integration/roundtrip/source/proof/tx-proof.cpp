// Transaction-overload proof adapter. No daemon, wallet database or spend API.
#include "wallet/wallet2.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "cryptonote_basic/cryptonote_basic_impl.h"
#include "string_tools.h"
#include <rapidjson/document.h>
#include <fstream>
#include <iostream>
#include <stdexcept>

static unsigned checkpoint=0;
static void need_at(bool good,unsigned line) { checkpoint=line; if (!good) throw std::runtime_error("proof-error"); }
#define need(good) need_at((good),__LINE__)
static std::string load(const char* path, size_t limit) {
  std::ifstream input(path, std::ios::binary); need(bool(input));
  std::string bytes; char c;
  while (input.get(c)) { need(bytes.size() < limit); bytes += c; }
  need(input.eof() && !bytes.empty()); return bytes;
}
static std::string field(const rapidjson::Document& d, const char* key, size_t cap) {
  need(d.HasMember(key) && d[key].IsString());
  std::string result(d[key].GetString(), d[key].GetStringLength());
  need(!result.empty() && result.size() <= cap); return result;
}
static std::string hex(const std::string& data) { return epee::string_tools::buff_to_hex_nodelimer(data); }
static std::string unhex(const std::string& data) {
  need(data.size()%2==0 && data.find_first_not_of("0123456789abcdef")==std::string::npos);
  std::string bytes; need(epee::string_tools::parse_hexstr_to_binbuff(data, bytes)); need(hex(bytes)==data); return bytes;
}
int main(int argc, char** argv) {
  try {
    need(argc==3 || argc==4); const std::string mode=argv[1];
    need((mode=="produce" && argc==4) || (mode=="verify" && argc==3));
    const auto raw=load(argv[2], 600000); rapidjson::Document d; d.Parse(raw.data(),raw.size());
    need(!d.HasParseError() && d.IsObject() && d.MemberCount()==5);
    const auto tx_hex=field(d,"txHex",524288), tx_id=field(d,"txId",64), address_text=field(d,"vaultAddress",256), message_hex=field(d,"messageHex",8192);
    need(d.HasMember("proof") && d["proof"].IsString());
    std::string proof(d["proof"].GetString(),d["proof"].GetStringLength()); need(proof.size()<=65546);
    const auto blob=unhex(tx_hex), message=unhex(message_hex); need(unhex(tx_id).size()==32);
    need(message.find('\0')==std::string::npos);
    cryptonote::transaction tx;
    need(cryptonote::parse_and_validate_tx_from_blob(blob,tx)); need(cryptonote::tx_to_blob(tx)==blob);
    const auto actual_id=cryptonote::get_transaction_hash(tx);
    need(hex(std::string(reinterpret_cast<const char*>(&actual_id),32))==tx_id);
    cryptonote::address_parse_info address;
    need(cryptonote::get_account_address_from_str(address,cryptonote::MAINNET,address_text));
    need(!address.is_subaddress && !address.has_payment_id);
    need(cryptonote::get_account_address_as_str(cryptonote::MAINNET,false,address.address)==address_text);
    tools::wallet2 wallet(cryptonote::FAKECHAIN);
    if(mode=="produce") {
      need(proof.empty()); auto key_bytes=load(argv[3],32); need(key_bytes.size()==32);
      crypto::secret_key key; std::copy(key_bytes.begin(),key_bytes.end(),key.data); memwipe(&key_bytes[0],key_bytes.size());
      crypto::public_key public_key;
      need(crypto::secret_key_to_public_key(key,public_key));
      need(public_key==cryptonote::get_tx_pub_key_from_extra(tx));
      need(cryptonote::get_additional_tx_pub_keys_from_extra(tx).empty());
      checkpoint=1001; proof=wallet.get_tx_proof(tx,key,{},address.address,false,message);
      memwipe(key.data,sizeof(key.data));
    }
    need(proof.compare(0,10,"OutProofV2")==0);
    need(proof.substr(10).find_first_not_of("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")==std::string::npos);
    uint64_t received=0;
    checkpoint=1002; const bool good=wallet.check_tx_proof(tx,address.address,false,message,proof,received);
    if(mode=="produce") need(good && received>0);
    std::cout << "{\"good\":" << (good?"true":"false") << ",\"messageHex\":\"" << message_hex
      << "\",\"proof\":\"" << proof << "\",\"received\":\"" << received
      << "\",\"sourcePin\":\"4f92268d7c16741cfb41e5bbe2aa46cc260a9ea5\",\"txId\":\"" << tx_id
      << "\",\"vaultAddress\":\"" << address_text << "\"}\n";
    return 0;
  } catch (...) { std::cerr << "proof-error:" << checkpoint << "\n"; return 1; }
}
