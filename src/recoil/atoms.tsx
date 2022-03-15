import { atom, atomFamily, selector, selectorFamily, waitForAll } from "recoil";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokenListProvider, TokenInfo } from "@solana/spl-token-registry";
import { Spl, Provider, Program, SplToken } from "@project-serum/anchor";
import * as anchor from "@project-serum/anchor";
import { metadata } from "@project-serum/token";
import { TokenAccountWithKey } from "./types";
import {
  UI_RPC_METHOD_CONNECTION_URL_READ,
  UI_RPC_METHOD_CONNECTION_URL_UPDATE,
  UI_RPC_METHOD_KEYRING_STORE_READ_ALL_PUBKEYS,
  UI_RPC_METHOD_WALLET_DATA_ACTIVE_WALLET,
  UI_RPC_METHOD_KEYRING_STORE_STATE,
  UI_RPC_METHOD_NAVIGATION_UPDATE,
  UI_RPC_METHOD_NAVIGATION_READ,
  UI_RPC_METHOD_NAVIGATION_ACTIVE_TAB_READ,
  UI_RPC_METHOD_NAVIGATION_ACTIVE_TAB_UPDATE,
  NAV_COMPONENT_BALANCES_NETWORK,
  NAV_COMPONENT_TOKEN,
  TAB_BALANCES,
} from "../common";
import { getBackgroundClient } from "../background/client";
import { WalletPublicKeys, TokenDisplay } from "./types";
import { KeyringStoreState } from "../keyring/store";
import { SolanaWallet } from "../context/Wallet";
import { Network } from "../components/Unlocked/Balances/Network";
import { TABS } from "../background/backend";
import { Token } from "../components/Unlocked/Balances/Token";

/**
 * Defines the initial app load fetch.
 */
export const bootstrap = atom<any>({
  key: "bootstrap",
  default: selector({
    key: "bootstrapSelector",
    get: async ({ get }: any) => {
      const tokenRegistry = get(splTokenRegistry);
      const wallet = get(solanaWallet);
      const { provider, tokenClient } = get(anchorContext);
      try {
        //
        // Fetch the SPL tokens.
        //
        const splTokenAccounts = await fetchTokens(wallet, tokenClient);

        //
        // Fetch the price data.
        //
        const coingeckoData = await fetchPriceData(
          splTokenAccounts,
          tokenRegistry
        );

        //
        // Fetch the nfts.
        //
        const splMetadata = await fetchSplMetadata(
          provider,
          Array.from(splTokenAccounts.values())
        );

        //
        // Done.
        //
        return {
          splTokenAccounts,
          splMetadata,
          coingeckoData,
        };
      } catch (err) {
        // TODO: show error notification.
        console.error(err);
      }
    },
  }),
});

// Version of bootstrap for very fast data on load. This shouldn't block the load
// in any discernable way.
export const bootstrapFast = atom<any>({
  key: "bootstrapFast",
  default: selector({
    key: "bootstrapFastSelector",
    get: async ({ get }: any) => {
      // Fetch all navigation state.
      const backgroundClient = getBackgroundClient();
      const tabs = await Promise.all(
        TABS.map((t) =>
          backgroundClient.request({
            method: UI_RPC_METHOD_NAVIGATION_READ,
            params: [t[0]],
          })
        )
      );
      return {
        tabs,
      };
    },
  }),
});

export const navigationActiveTab = atom<string>({
  key: "navigationActiveTab",
  default: TAB_BALANCES,
  effects: [
    ({ setSelf, onSet }) => {
      setSelf(
        (async () => {
          const background = getBackgroundClient();
          return background.request({
            method: UI_RPC_METHOD_NAVIGATION_ACTIVE_TAB_READ,
            params: [],
          });
        })()
      );

      onSet((activeTab) => {
        const background = getBackgroundClient();
        return background.request({
          method: UI_RPC_METHOD_NAVIGATION_ACTIVE_TAB_UPDATE,
          params: [activeTab],
        });
      });
    },
  ],
});

/**
 * Each atom in the family represents a single navigation stack. This is used
 * to persistently keep track of the UI state the user left the tab in, so that
 * when the user switches back and forth, the state doesn't reset.
 */
export const navigationDataMap = atomFamily<any, string>({
  key: "navigationState",
  default: selectorFamily({
    key: "navigationStateDefault",
    get:
      (navKey: string) =>
      ({ get }: any) => {
        const { tabs } = get(bootstrapFast);
        // @ts-ignore
        return tabs.filter((t) => t.id === navKey)[0];
      },
  }),
  effects: (_nav: string) => [
    ({ onSet }) => {
      onSet((navData) => {
        const background = getBackgroundClient();
        background
          .request({
            method: UI_RPC_METHOD_NAVIGATION_UPDATE,
            params: [navData],
          })
          .catch(console.error);
      });
    },
  ],
});

/**
 * Maps component stringified label to an actual component constructor.
 */
export const navigationComponentMap = selectorFamily({
  key: "navigationStack",
  get:
    (navId: string) =>
    ({ get }) => {
      switch (navId) {
        case NAV_COMPONENT_BALANCES_NETWORK:
          return (props: any) => <Network {...props} />;
        case NAV_COMPONENT_TOKEN:
          return (props: any) => <Token {...props} />;
        default:
          throw new Error("invariant violation");
      }
    },
});

/**
 * Returns the function to render the component on the given navigation stack.
 */
export const navigationRenderer = selectorFamily({
  key: "navigationRenderer",
  get:
    (navKey: string) =>
    ({ get }) => {
      const navData = get(navigationDataMap(navKey));
      const componentStr =
        navData.components.length > 0
          ? navData.components[navData.components.length - 1]
          : undefined;
      const props =
        navData.props.length > 0
          ? navData.props[navData.props.length - 1]
          : undefined;
      if (!componentStr) {
        return undefined;
      }
      return () => get(navigationComponentMap(componentStr))(props);
    },
});

export const navigationBorderBottom = atom<boolean>({
  key: "navigationBorderBottom",
  default: true,
});

export const navigationRightButton = atom<any | null>({
  key: "navigationRightButton",
  default: null,
});

/**
 * Toggle for darkmode.
 */
export const isDarkMode = atom<boolean>({
  key: "isDarkMode",
  default: true,
});

/**
 * Status of the keyring store.
 */
export const keyringStoreState = atom<KeyringStoreState | null>({
  key: "keyringStoreState",
  default: null,
  effects: [
    ({ setSelf }) => {
      const background = getBackgroundClient();
      setSelf(
        background.request({
          method: UI_RPC_METHOD_KEYRING_STORE_STATE,
          params: [],
        })
      );
    },
  ],
});

/**
 * List of all public keys for the wallet along with associated nicknames.
 */
export const walletPublicKeys = atom<WalletPublicKeys>({
  key: "walletPublicKeys",
  default: { hdPublicKeys: [], importedPublicKeys: [] },
  effects: [
    ({ setSelf }) => {
      const background = getBackgroundClient();
      setSelf(
        background.request({
          method: UI_RPC_METHOD_KEYRING_STORE_READ_ALL_PUBKEYS,
          params: [],
        })
      );
    },
  ],
});

/**
 * Pubkey of the currently selected wallet.
 */
export const activeWallet = atom<string | null>({
  key: "activeWallet",
  default: null,
  effects: [
    ({ setSelf }) => {
      const background = getBackgroundClient();
      setSelf(
        background.request({
          method: UI_RPC_METHOD_WALLET_DATA_ACTIVE_WALLET,
          params: [],
        })
      );
    },
  ],
});

/**
 * Currently selected wallet with display data.
 */
export const activeWalletWithName = selector({
  key: "filteredTodoListState",
  get: ({ get }) => {
    const active = get(activeWallet);
    const pks = get(walletPublicKeys);
    let result = pks.hdPublicKeys.find(
      (pk) => pk.publicKey.toString() === active
    );
    if (result) {
      return result;
    }
    result = pks.importedPublicKeys.find(
      (pk) => pk.publicKey.toString() === active
    );
    return result;
  },
});

/**
 * All blockchains.
 */
export const blockchainKeys = atom<Array<string>>({
  key: "blockchainKeys",
  default: ["solana"],
});

/**
 * Selects a blockchain token list based on a network string.
 */
export const blockchainTokens = selectorFamily({
  key: "blockchainTokens",
  get:
    (b: string) =>
    ({ get }: any) => {
      switch (b) {
        case "solana":
          return get(solanaTokenAccountKeys);
        default:
          throw new Error("invariant violation");
      }
    },
});

export const priceData = atomFamily<TokenDisplay | null, string>({
  key: "priceData",
  default: selectorFamily({
    key: "priceDataDefault",
    get:
      (address: string) =>
      ({ get }: any) => {
        const data = get(bootstrap);
        return data.coingeckoData.get(address);
      },
  }),
});

export const splTokenRegistry = atom<Map<string, TokenInfo> | null>({
  key: "splTokenRegistry",
  default: null,
  effects: [
    ({ setSelf }) => {
      setSelf(
        new TokenListProvider().resolve().then((tokens) => {
          const tokenList = tokens
            .filterByClusterSlug("mainnet-beta") // TODO: get network atom.
            .getList();
          return tokenList.reduce((map, item) => {
            map.set(item.address, item);
            return map;
          }, new Map());
        })
      );
    },
  ],
});

export const blockchainTokenAccounts = selectorFamily({
  key: "blockchainTokenAccountsMap",
  get:
    ({ address, blockchain }: { address: string; blockchain: string }) =>
    ({ get }: any) => {
      switch (blockchain) {
        case "solana":
          const tokenAccount = get(solanaTokenAccountsMap(address));
          const tokenRegistry = get(splTokenRegistry);
          const price = get(priceData(tokenAccount.mint.toString()));
          const tokenMetadata =
            tokenRegistry.get(tokenAccount.mint.toString()) ?? {};
          const ticker = tokenMetadata.symbol;
          const logo = tokenMetadata.logoURI;
          const name = tokenMetadata.name;
          const nativeBalance = tokenAccount.amount
            .div(
              tokenMetadata.decimals
                ? new BN(10 ** tokenMetadata.decimals)
                : new BN(1)
            )
            .toNumber();
          const currentUsdBalance =
            price && price.usd ? price.usd * nativeBalance : 0;
          const oldUsdBalance =
            currentUsdBalance === 0
              ? 0
              : currentUsdBalance / (1 + price.usd_24h_change);
          const recentUsdBalanceChange =
            (currentUsdBalance - oldUsdBalance) / oldUsdBalance;
          return {
            name,
            nativeBalance,
            ticker,
            logo,
            address,
            mint: tokenAccount.mint.toString(),
            usdBalance: currentUsdBalance,
            recentUsdBalanceChange,
            priceData: price,
          };
        default:
          throw new Error("invariant violation");
      }
    },
});

export const total = selector({
  key: "total",
  get: ({ get }: any) => {
    const blockchains = get(blockchainKeys);
    const total = blockchains.map((b: string) => get(blockchainTotal(b)));
    // @ts-ignore
    const totalBalance = total
      .map((t: any) => t.totalBalance)
      .reduce((a: number, b: number) => a + b);
    // @ts-ignore
    const totalChange = total
      .map((t: any) => t.totalChange)
      .reduce((a: number, b: number) => a + b);
    const oldBalance = totalBalance - totalChange;
    const percentChange = totalChange / oldBalance;
    return {
      totalBalance: parseFloat(totalBalance.toFixed(2)),
      totalChange: parseFloat(totalChange.toFixed(2)),
      percentChange: parseFloat(percentChange.toFixed(2)),
    };
  },
});

export const blockchainTotal = selectorFamily({
  key: "blockchainTotal",
  get:
    (blockchain: string) =>
    ({ get }: any) => {
      const tokens = get(blockchainTokensSorted(blockchain)).filter(
        (t: any) => t.usdBalance && t.recentUsdBalanceChange
      );

      // @ts-ignore
      const totalBalance = tokens
        // @ts-ignore
        .map((t) => t.usdBalance)
        // @ts-ignore
        .reduce((a, b) => a + b, 0);
      // @ts-ignore
      const totalChange = tokens
        // @ts-ignore
        .map((t) => t.recentUsdBalanceChange)
        // @ts-ignore
        .reduce((a, b) => a + b, 0);
      const oldBalance = totalBalance - totalChange;
      const percentChange = totalChange / oldBalance;
      return {
        totalBalance: parseFloat(totalBalance.toFixed(2)),
        totalChange: parseFloat(totalChange.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
      };
    },
});

/**
 * Returns the token accounts sorted by usd notional balances.
 */
export const blockchainTokensSorted = selectorFamily({
  key: "blockchainTokensSorted",
  get:
    (blockchain: string) =>
    ({ get }: any) => {
      const tokenAddresses = get(blockchainTokens(blockchain));
      const tokenAccounts = tokenAddresses.map((address: string) =>
        get(
          blockchainTokenAccounts({
            address,
            blockchain,
          })
        )
      );
      // @ts-ignore
      return tokenAccounts.sort((a, b) => b.usdBalance - a.usdBalance);
    },
});

/**
 * List of all stored token accounts within tokenAccountsMap.
 */
export const solanaTokenAccountKeys = atom<Array<string>>({
  key: "solanaTokenAccountKeys",
  default: selector({
    key: "solanaTokenAccountKeysDefault",
    get: ({ get }: any) => {
      const data = get(bootstrap);
      return Array.from(data.splTokenAccounts.keys()) as string[];
    },
  }),
});

/**
 * Store the info from the SPL Token Account owned by the connected wallet.
 */
export const solanaTokenAccountsMap = atomFamily<
  TokenAccountWithKey | null,
  string
>({
  key: "solanaTokenAccountsMap",
  default: selectorFamily({
    key: "solanaTokenAccountsMapDefault",
    get:
      (address: string) =>
      ({ get }: any) => {
        const data = get(bootstrap);
        return data.splTokenAccounts.get(address);
      },
  }),
});

export const solanaNftMetadata = atom<Array<any>>({
  key: "solanaNftKeys",
  default: selector({
    key: "solanaNftKeysDefault",
    get: ({ get }: any) => {
      const b = get(bootstrap);
      console.log("boot", b);
      // @ts-ignore
      const nftMetadata = Array.from(b.splMetadata.values())
        // @ts-ignore
        .filter((t) => t.metadata.data.uri && t.metadata.data.uri.length > 0)
        .map((nft) => nft);
      return nftMetadata;
    },
  }),
});

/**
 * URL to the cluster to communicate with.
 */
// TODO: this needs to be an atom family keyed on blockchain label.
const DEFAULT_CONNECTION_URL = "https://solana-api.projectserum.com";
export const connectionUrl = atom<string>({
  key: "clusterConnection",
  default: DEFAULT_CONNECTION_URL,
  effects: [
    ({ setSelf }) => {
      const background = getBackgroundClient();
      setSelf(
        background
          .request({
            method: UI_RPC_METHOD_CONNECTION_URL_READ,
            params: [],
          })
          .then((result) => result ?? DEFAULT_CONNECTION_URL)
      );
    },
    ({ onSet }) => {
      onSet((cluster) => {
        // TODO: do we want to handle this via notification instead?
        const background = getBackgroundClient();
        background
          .request({
            method: UI_RPC_METHOD_CONNECTION_URL_UPDATE,
            params: [cluster],
          })
          .catch(console.error);
      });
    },
  ],
});

export const solanaWallet = selector({
  key: "solanaWallet",
  get: ({ get }: any) => {
    const pubkeyStr = get(activeWallet);
    const publicKey = new PublicKey(pubkeyStr!);
    //    return new SolanaWallet(publicKey);
    return new SolanaWallet(
      new PublicKey("B987jRxFFnSBULwu6cXRKzUfKDDpyuhCGC58wVxct6Ez")
    );
  },
});

export const anchorContext = selector({
  key: "anchorContext",
  get: ({ get }: any) => {
    const wallet = get(solanaWallet);
    const connectionUrlStr = get(connectionUrl);
    const connection = new Connection(connectionUrlStr);
    // @ts-ignore
    const provider = new Provider(connection, wallet, {
      skipPreflight: false,
      commitment: "recent",
      preflightCommitment: "recent",
    });
    const tokenClient = Spl.token(provider);
    return {
      connection,
      provider,
      tokenClient,
    };
  },
});

async function fetchCoingecko(coingeckoId: string) {
  const resp = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`
  );
  return await resp.json();
}

/**
 * Effective view model for each tab's navigation controller.
 */
export const navigation = atom({
  key: "navigation",
  default: "balances",
  effects: [
    ({ onSet }) => {
      onSet((cluster) => {
        // TODO: do we want to handle this via notification instead?
        const background = getBackgroundClient();
        background
          .request({
            method: UI_RPC_METHOD_CONNECTION_URL_UPDATE,
            params: [cluster],
          })
          .catch(console.error);
      });
    },
  ],
});

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
async function metadataAddress(mint: PublicKey): Promise<PublicKey> {
  return (
    await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    )
  )[0];
}

async function fetchTokens(
  wallet: SolanaWallet,
  tokenClient: Program<SplToken>
): Promise<Map<string, TokenAccountWithKey>> {
  //
  // Fetch the accounts.
  //
  const resp = await tokenClient.provider.connection.getTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: tokenClient.programId,
    }
  );

  //
  // Decode the data.
  //
  const tokens: Array<[string, TokenAccountWithKey]> = resp.value.map(
    ({ account, pubkey }: any) => [
      pubkey.toString(),
      {
        ...tokenClient.coder.accounts.decode("Token", account.data),
        key: pubkey,
      },
    ]
  );

  //
  // Filter out any invalid tokens.
  //
  const validTokens = tokens.filter(([, t]) => t.amount.toNumber() >= 1);

  //
  // Done.
  //
  return new Map(validTokens);
}

async function fetchSplMetadata(
  provider: Provider,
  tokens: Array<TokenAccountWithKey>
): Promise<Map<string, any>> {
  //
  // Fetch metadata for each token.
  //
  const metaAddrs = await Promise.all(
    tokens.map(async (t: any) => {
      return {
        token: t,
        publicKey: t.key,
        metadataAddress: await metadataAddress(t.mint),
      };
    })
  );
  const tokenMetaAccounts = (
    await anchor.utils.rpc.getMultipleAccounts(
      provider.connection,
      metaAddrs.map((t: any) => t.metadataAddress)
    )
  ).map((t) =>
    t
      ? {
          publicKey: t!.publicKey,
          account: metadata.decodeMetadata(t!.account.data),
        }
      : null
  );

  //
  // Fetch the URI for each metadata.
  //
  const tokenMetaUriData = await Promise.all(
    tokenMetaAccounts
      // @ts-ignore
      .map(async (t) => {
        if (t === null || t === undefined || !t.account.data.uri) {
          return null;
        }
        try {
          // @ts-ignore
          const resp = await fetch(t.account.data.uri);
          return resp.json();
        } catch (err) {
          console.error(err);
        }
      })
  );

  //
  // Zip it all together.
  //
  const splMetadata: Map<string, any> = new Map(
    // @ts-ignore
    tokens
      // @ts-ignore
      .map((m, idx) => {
        const tokenMetadata = tokenMetaAccounts[idx];
        if (tokenMetadata === null) {
          return null;
        }
        if (tokenMetadata === undefined) {
          return null;
        }
        return [
          m.key,
          {
            publicKey: m.key,
            metadataAddress: tokenMetadata.publicKey,
            metadata: tokenMetadata.account,
            tokenMetaUriData: tokenMetaUriData[idx],
          },
        ];
      })
      // @ts-ignore
      .filter((m) => m !== null)
  );

  //
  // Done.
  //
  return splMetadata;
}

async function fetchPriceData(
  splTokenAccounts: Map<string, TokenAccountWithKey>,
  tokenRegistry: Map<string, TokenInfo>
): Promise<Map<string, any>> {
  const mintCoingeckoIds = Array.from(splTokenAccounts.keys())
    .map((k) => splTokenAccounts.get(k)!.mint.toString())
    .filter((mint) => tokenRegistry!.get(mint) !== undefined)
    .map((mint) => [mint, tokenRegistry!.get(mint)!.extensions])
    .filter(([, e]: any) => e !== undefined && e.coingeckoId !== undefined)
    .map(([mint, e]: any) => [mint, e!.coingeckoId]);
  const idToMint = new Map(mintCoingeckoIds.map((m) => [m[1], m[0]]));
  const coingeckoIds = Array.from(idToMint.keys()).join(",");
  const coingeckoResp = await fetchCoingecko(coingeckoIds);
  const coingeckoData = new Map(
    Object.keys(coingeckoResp).map((id) => [
      idToMint.get(id),
      coingeckoResp[id],
    ])
  );
  return coingeckoData;
}
