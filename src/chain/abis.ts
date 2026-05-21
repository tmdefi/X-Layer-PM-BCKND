export const marketFactoryAbi = [
  {
    type: "function",
    name: "createBinaryMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "oracle", type: "address" },
      { name: "questionId", type: "bytes32" },
      { name: "marketType", type: "string" },
      { name: "metadataURI", type: "string" }
    ],
    outputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "token0", type: "uint256" },
      { name: "token1", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "questionId", type: "bytes32" },
      { name: "oracle", type: "address" },
      { name: "token0", type: "uint256" },
      { name: "token1", type: "uint256" },
      { name: "created", type: "bool" }
    ]
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "conditionId", type: "bytes32", indexed: true },
      { name: "token0", type: "uint256", indexed: true },
      { name: "token1", type: "uint256", indexed: false },
      { name: "oracle", type: "address", indexed: false },
      { name: "questionId", type: "bytes32", indexed: false },
      { name: "marketType", type: "string", indexed: false },
      { name: "metadataURI", type: "string", indexed: false }
    ]
  }
] as const;

export const binaryMarketResolverAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "outcome", type: "uint8" }
    ],
    outputs: [{ name: "conditionId", type: "bytes32" }]
  },
  {
    type: "function",
    name: "getConditionId",
    stateMutability: "view",
    inputs: [{ name: "questionId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }]
  }
] as const;

export const exchangeOrderComponents = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "taker", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "feeRateBps", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "signature", type: "bytes" }
] as const;

export const ctfExchangeAbi = [
  {
    type: "function",
    name: "hashOrder",
    stateMutability: "view",
    inputs: [{ name: "order", type: "tuple", components: exchangeOrderComponents }],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "validateOrder",
    stateMutability: "view",
    inputs: [{ name: "order", type: "tuple", components: exchangeOrderComponents }],
    outputs: []
  },
  {
    type: "function",
    name: "getOrderStatus",
    stateMutability: "view",
    inputs: [{ name: "orderHash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "isFilledOrCancelled", type: "bool" },
          { name: "remaining", type: "uint256" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "incrementNonce",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "order", type: "tuple", components: exchangeOrderComponents }],
    outputs: []
  },
  {
    type: "function",
    name: "matchOrders",
    stateMutability: "nonpayable",
    inputs: [
      { name: "takerOrder", type: "tuple", components: exchangeOrderComponents },
      { name: "makerOrders", type: "tuple[]", components: exchangeOrderComponents },
      { name: "takerFillAmount", type: "uint256" },
      { name: "makerFillAmounts", type: "uint256[]" }
    ],
    outputs: []
  }
] as const;
