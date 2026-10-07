cmake_minimum_required(VERSION 3.16)
set(ROSEN_FCMP_SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}")

# Included after the pinned Monero tree, so its targets and generated headers
# remain authoritative. No vendored replacement of construction or proof code.
if(NOT TARGET wallet)
  message(FATAL_ERROR "Add the pinned Monero source tree before this adapter")
endif()

add_library(rosen_fcmp_adapter STATIC "${ROSEN_FCMP_SOURCE_DIR}/core/threshold_spend_device.cpp")
target_compile_features(rosen_fcmp_adapter PUBLIC cxx_std_17)
target_include_directories(rosen_fcmp_adapter PUBLIC
  "${ROSEN_FCMP_SOURCE_DIR}/core"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/src"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/contrib/epee/include")
target_link_libraries(rosen_fcmp_adapter PUBLIC wallet)

add_executable(fcmp_adapter_fixture "${ROSEN_FCMP_SOURCE_DIR}/core/adapter_fixture.cpp")
target_link_libraries(fcmp_adapter_fixture PRIVATE rosen_fcmp_adapter)

add_library(rosen_carrot_receipt STATIC "${ROSEN_FCMP_SOURCE_DIR}/proof/carrot_receipt.cpp")
target_compile_features(rosen_carrot_receipt PUBLIC cxx_std_17)
target_include_directories(rosen_carrot_receipt PUBLIC
  "${ROSEN_FCMP_SOURCE_DIR}/proof"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/src"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/contrib/epee/include")
target_link_libraries(rosen_carrot_receipt PUBLIC wallet)
target_link_libraries(fcmp_adapter_fixture PRIVATE rosen_carrot_receipt)
add_executable(rosen_carrot_receipt_tests "${ROSEN_FCMP_SOURCE_DIR}/proof/carrot_receipt_tests.cpp"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/tests/unit_tests/carrot_mock_helpers.cpp")
target_include_directories(rosen_carrot_receipt_tests PRIVATE
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/tests/unit_tests")
target_link_libraries(rosen_carrot_receipt_tests PRIVATE rosen_carrot_receipt wallet)

# Offline fakechain with legacy outputs before the pinned FCMP++ activation.
add_executable(legacy_node_fixture "${ROSEN_FCMP_SOURCE_DIR}/core/legacy_node_fixture.cpp")
target_compile_features(legacy_node_fixture PRIVATE cxx_std_17)
target_include_directories(legacy_node_fixture PRIVATE
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/src"
  "${ROSEN_FCMP_SOURCE_DIR}/../upstream/contrib/epee/include")
target_link_libraries(legacy_node_fixture PRIVATE
  rpc p2p cryptonote_protocol cryptonote_core blockchain_db cncrypto common version
  ${Boost_FILESYSTEM_LIBRARY} ${Boost_PROGRAM_OPTIONS_LIBRARY}
  ${Boost_REGEX_LIBRARY} ${Boost_SYSTEM_LIBRARY} ${CMAKE_THREAD_LIBS_INIT}
  ${EXTRA_LIBRARIES} $<TARGET_NAME_IF_EXISTS:blocks>)
