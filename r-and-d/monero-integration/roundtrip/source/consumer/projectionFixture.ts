import {configureFixtureTokens} from './fixturePorts';
import {MoneroChain} from './adapter';
import {setFixtureChain} from './resolver';
import {buildUnapprovedMoneroPayout} from '../guard-service/src/withdrawal/moneroWithdrawalOrder';

// Public deterministic Testnet receiver, checked by the actual Rust ViewPair.
export const recipient='9vWx1vQmqjsJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmJ7suhUXwdrDJ8QgRfFWTzmJ8QgRfFWTzmJ8QgRfFWTzmCaX3TNi';
export function terms() {
  return {source:{event:{height:100,fromChain:'ergo',toChain:'monero',fromAddress:'synthetic-source',toAddress:recipient,
    amount:'1000000120',bridgeFee:'100',networkFee:'20',sourceChainTokenId:'a'.repeat(64),targetChainTokenId:'XMR',
    sourceTxId:'b'.repeat(64),sourceChainHeight:90,sourceBlockId:'c'.repeat(64),WIDsHash:'d'.repeat(64),WIDsCount:1},
    triggerTransactionId:'e'.repeat(64),triggerBoxId:'f'.repeat(64),wids:['01'.repeat(32)]},
  profile:{version:'1',sourceNetwork:'testnet',destinationNetwork:'testnet',epoch:'1',configurationId:'synthetic-retained-withdrawal-1',
    fees:{bridgeFee:100n,networkFee:20n,rsnRatio:0n,rsnRatioDivisor:100n,feeRatio:0n,feeRatioDivisor:10000n},
    tokens:[{ergo:{tokenId:'a'.repeat(64),name:'synthetic rsXMR',decimals:12,type:'EIP-004',residency:'wrapped',extra:{}},
      monero:{tokenId:'XMR',name:'XMR',decimals:12,type:'native',residency:'native',extra:{}}}],
    sourceDecimals:12,destinationDecimals:12,minimumNativeTopUp:'0',maxMinerFeeAtomic:'100000'}};
}
export async function fixture() {
  const data=terms();await configureFixtureTokens(data.profile.tokens);
  const chain=await MoneroChain.create();setFixtureChain(chain);
  const request=await buildUnapprovedMoneroPayout(data.source,data.profile);
  return {data,chain,request};
}
