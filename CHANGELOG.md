# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-04-09

### Added
- Initial release
- RFQ trading: createRFQ, submitQuote, acceptQuote, listRFQs, cancelRFQ
- Trade management: getTrade, listTrades, acceptTrade, cancelTrade, confirmDirectTrade
- EVM HTLC: fundHTLC, claimHTLC, refundHTLC, getHTLCStatus
- Bitcoin HTLC: prepareBitcoinHTLC, buildBitcoinClaimPSBT, broadcastBitcoinTx
- Settlement wallet management: confirmSettlementWallets
- Full TypeScript types for all inputs and outputs
- Automatic retry with exponential backoff
- Error hierarchy: HashLockError, GraphQLError, NetworkError, AuthError
- ESM + CJS dual build
