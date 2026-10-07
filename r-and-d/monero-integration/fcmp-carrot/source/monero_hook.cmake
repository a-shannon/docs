if(CMAKE_VERSION VERSION_LESS 3.19)
  message(FATAL_ERROR "The adapter inclusion hook requires CMake 3.19 or later")
endif()
set(ROSEN_FCMP_ADAPTER_DIR "${CMAKE_CURRENT_LIST_DIR}")
# Include after Monero has declared its wallet, Core and RPC targets.
cmake_language(DEFER CALL include "${ROSEN_FCMP_ADAPTER_DIR}/CMakeLists.txt")
