fn main() {
    // Fixture failures never format native state, input material or process paths.
    std::panic::set_hook(Box::new(|_| eprintln!("host:panic")));
    let result = std::panic::catch_unwind(pedpop_wallet_type_join::run_synthetic_candidate_host);
    if !matches!(result, Ok(Ok(()))) {
        eprintln!("host:rejected");
        std::process::exit(2);
    }
}
