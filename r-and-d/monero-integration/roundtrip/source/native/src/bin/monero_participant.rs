fn main() {
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some("recover" | "observe")
    ) {
        let args = std::env::args().skip(2).collect::<Vec<_>>();
        let result = if args.len() == 2 {
            if std::env::args().nth(1).as_deref() == Some("recover") {
                pedpop_wallet_type_join::participant::recover(
                    std::path::Path::new(&args[0]),
                    &args[1],
                    std::io::stdout().lock(),
                )
            } else {
                pedpop_wallet_type_join::participant::observe(
                    std::path::Path::new(&args[0]),
                    &args[1],
                    std::io::stdout().lock(),
                )
            }
        } else {
            Err(())
        };
        if result.is_err() {
            eprintln!("participant-error");
            std::process::exit(1)
        }
        return;
    }
    let mut args = std::env::args().skip(1);
    let result = args
        .next()
        .and_then(|s| {
            if s.len() == 1 {
                s.parse::<u16>().ok()
            } else {
                None
            }
        })
        .filter(|_| args.next().is_none())
        .ok_or(())
        .and_then(|id| {
            pedpop_wallet_type_join::participant::run(
                id,
                std::io::stdin().lock(),
                std::io::stdout().lock(),
            )
        });
    if result.is_err() {
        eprintln!("participant-error");
        std::process::exit(1);
    }
}
