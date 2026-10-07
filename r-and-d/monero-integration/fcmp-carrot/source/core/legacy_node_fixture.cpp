// Local consensus fixture for Monero beta3 d816367cb1aa405bfa68a20ac3e034d0759d968e.
// This executable creates a fresh fake chain; it is not a daemon replacement.
#include <atomic>
#include <chrono>
#include <csignal>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

#include <boost/filesystem.hpp>
#include <boost/program_options.hpp>
#include "common/command_line.h"
#include "common/util.h"
#include "cryptonote_core/cryptonote_core.h"
#include "cryptonote_protocol/cryptonote_protocol_handler.h"
#include "p2p/net_node.h"
#include "rpc/core_rpc_server.h"

namespace
{
volatile std::sig_atomic_t interrupted = 0;
void interrupt_handler(int) { interrupted = 1; }

std::string port_argument(const char* value)
{
  const std::string text{value};
  if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos)
    throw std::runtime_error("Ports must be decimal integers");
  const auto port = std::stoul(text);
  if (port < 1024 || port > 65535)
    throw std::runtime_error("Ports must be in [1024,65535]");
  return std::to_string(port);
}

void require(bool condition, const char* message)
{
  if (!condition) throw std::runtime_error(message);
}
}

int main(int argc, char** argv)
{
  try
  {
    require(argc == 4, "Usage: legacy_node_fixture NEW_ABSOLUTE_DATA_DIR RPC_PORT P2P_PORT");
    const boost::filesystem::path data_dir{argv[1]};
    const auto rpc_port = port_argument(argv[2]);
    const auto p2p_port = port_argument(argv[3]);
    require(data_dir.is_absolute() && data_dir != data_dir.root_path(), "Data directory must be absolute and not a filesystem root");
    require(rpc_port != p2p_port, "RPC and P2P ports must differ");
    require(!boost::filesystem::exists(data_dir), "Fresh fixture required: data directory already exists");
    require(boost::filesystem::is_directory(data_dir.parent_path()), "Create the parent directory before starting this fixture");
    // Atomic directory creation prevents a check/create race from opening another database.
    require(boost::filesystem::create_directory(data_dir), "Could not exclusively create fixture directory");
    {
      std::ofstream marker{(data_dir / "legacy-fixture.txt").string(), std::ios::out | std::ios::binary};
      marker << "upstream=d816367cb1aa405bfa68a20ac3e034d0759d968e\n"
                "network=fakechain\nhard_forks=1:0,16:1,17:70,18:71\n";
      marker.close();
      require(bool(marker), "Could not persist fresh fixture marker");
    }

    tools::on_startup();
    epee::string_tools::set_module_name_and_folder(argv[0]);
    mlog_configure((data_dir / "fixture.log").string(), true);
    mlog_set_log_level(0);
    std::signal(SIGINT, interrupt_handler);
    std::signal(SIGTERM, interrupt_handler);

    using protocol_type = cryptonote::t_cryptonote_protocol_handler<cryptonote::core>;
    using p2p_type = nodetool::node_server<protocol_type>;
    namespace po = boost::program_options;
    po::options_description options{"Pinned local fixture options"};
    cryptonote::core::init_options(options);
    p2p_type::init_options(options);
    cryptonote::core_rpc_server::init_options(options);
    const std::vector<std::string> arguments{
      "--data-dir", data_dir.string(), "--offline", "--keep-fakechain",
      "--fixed-difficulty", "1", "--disable-dns-checkpoints", "--check-updates", "disabled",
      "--p2p-bind-ip", "127.0.0.1", "--p2p-bind-port", p2p_port,
      "--rpc-bind-ip", "127.0.0.1", "--rpc-bind-port", rpc_port,
      "--rpc-ssl", "disabled"};
    po::variables_map vm;
    po::store(po::command_line_parser(arguments).options(options).run(), vm);
    po::notify(vm);
    require(!command_line::get_arg(vm, cryptonote::arg_regtest_on), "Regtest flag would replace the fixture fork schedule");

    // HF17 introduces both CARROT and FCMP++; heights 1..69 remain legacy.
    const std::pair<uint8_t, uint64_t> forks[]{{1, 0}, {16, 1}, {17, 70}, {18, 71}, {0, 0}};
    const cryptonote::test_options test_options{forks, 0};
    cryptonote::core core{nullptr};
    protocol_type protocol{core, nullptr, true};
    p2p_type p2p{protocol};
    cryptonote::core_rpc_server rpc{core, p2p};
    bool core_initialized = false, protocol_initialized = false, p2p_initialized = false, rpc_initialized = false;
    const auto shutdown = [&]() {
      if (rpc_initialized) { rpc.send_stop_signal(); rpc.timed_wait_server_stop(5000); rpc.deinit(); }
      if (p2p_initialized) { p2p.send_stop_signal(); p2p.deinit(); }
      if (protocol_initialized) { protocol.deinit(); protocol.set_p2p_endpoint(nullptr); }
      if (core_initialized) { core.stop(); core.deinit(); core.set_cryptonote_protocol(nullptr); }
    };
    try
    {
      require(core.init(vm, &test_options, nullptr, false), "Core fixture initialization failed");
      core_initialized = true;
      require(core.get_nettype() == cryptonote::FAKECHAIN && core.offline(), "Core is not an offline fake chain");
      require(core.get_current_blockchain_height() == 1 &&
        core.get_ideal_hard_fork_version(0) == 1 && core.get_ideal_hard_fork_version(1) == 16 &&
        core.get_ideal_hard_fork_version(69) == 16 && core.get_ideal_hard_fork_version(70) == 17 &&
        core.get_ideal_hard_fork_version(71) == 18, "Core did not install the exact fixture fork schedule");
      require(protocol.init(vm), "Protocol initialization failed");
      protocol_initialized = true;
      // P2P infers its network solely from flags. Give ONLY P2P a copied map with
      // regtest=true; Core retains regtest=false and the explicit schedule above.
      auto p2p_vm = vm;
      p2p_vm.erase(cryptonote::arg_regtest_on.name);
      p2p_vm.insert({cryptonote::arg_regtest_on.name, po::variable_value{boost::any{true}, false}});
      require(p2p.init(p2p_vm, "", false), "Offline P2P initialization failed");
      p2p_initialized = true;
      protocol.set_p2p_endpoint(&p2p);
      core.set_cryptonote_protocol(&protocol);
      require(rpc.init(vm, false, rpc_port, ""), "Loopback RPC initialization failed");
      rpc_initialized = true;
      require(rpc.run(2, false), "Loopback RPC start failed");
      std::cout << "fixture_ready rpc=http://127.0.0.1:" << rpc_port
                << " network=fakechain offline=true forks=1:0,16:1,17:70,18:71" << std::endl;
      // Do not call network APIs in a signal handler. This watcher also exits when
      // the normal upstream stop_daemon RPC stops the P2P service.
      std::atomic<bool> done{false};
      std::thread signal_watcher{[&]() {
        while (!done.load())
        {
          if (interrupted) { p2p.send_stop_signal(); return; }
          std::this_thread::sleep_for(std::chrono::milliseconds{100});
        }
      }};
      try { p2p.run(); }
      catch (...) { done = true; signal_watcher.join(); throw; }
      done = true;
      signal_watcher.join();
      shutdown();
      std::cout << "fixture_stopped" << std::endl;
    }
    catch (...) { shutdown(); throw; }
    return 0;
  }
  catch (const std::exception& error)
  {
    std::cerr << "legacy_node_fixture: " << error.what() << std::endl;
    return 1;
  }
}
