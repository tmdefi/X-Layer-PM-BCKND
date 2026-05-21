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
