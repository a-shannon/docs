/** Absent built-in constructor packages are excluded by explicit scoped bootstrap. */
class UnusedChainConstructor { constructor() { throw Error('Unscoped chain constructor excluded'); } }
export default UnusedChainConstructor;
export const BINANCE_CHAIN='binance',BITCOIN_CHAIN='bitcoin',BITCOIN_RUNES_CHAIN='bitcoin-runes',CARDANO_CHAIN='cardano',DOGE_CHAIN='doge',ERGO_CHAIN='ergo',ETHEREUM_CHAIN='ethereum',FIRO_CHAIN='firo',HANDSHAKE_CHAIN='handshake';
export const BNB='BNB',BTC='BTC',ADA='ADA',DOGE='DOGE',ERG='ERG',ETH='ETH',FIRO='FIRO',HNS='HNS';
export const NODE_NETWORK='node',EXPLORER_NETWORK='explorer',BLOCKFROST_NETWORK='blockfrost',KOIOS_NETWORK='koios';
export const BinanceChain=UnusedChainConstructor,BitcoinChain=UnusedChainConstructor,BitcoinRunesChain=UnusedChainConstructor,BitcoinRunesRpcNetwork=UnusedChainConstructor,CardanoChain=UnusedChainConstructor,DogeChain=UnusedChainConstructor,CombinedDogeNetwork=UnusedChainConstructor,DogeBlockcypherNetwork=UnusedChainConstructor,DogeEsploraNetwork=UnusedChainConstructor,DogeRpcNetwork=UnusedChainConstructor,ErgoChain=UnusedChainConstructor,EthereumChain=UnusedChainConstructor,FiroChain=UnusedChainConstructor,FiroElectrumXNetwork=UnusedChainConstructor,HandshakeChain=UnusedChainConstructor,HandshakeRpcNetwork=UnusedChainConstructor;
