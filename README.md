# GitMark Demo

Bitcoin-anchored notes demo using [blocktrails](https://github.com/blocktrails/blocktrails) and [nostr-git-client](https://github.com/JavaScriptSolidServer/nostr-git-client).

**[Try the Demo](https://blocktrails.github.io/git-mark-demo/demo.html)**

## How It Works

1. **Sync** - Clone git repo to browser IndexedDB
2. **Edit** - Modify markdown notes in the browser
3. **Push** - Push changes to git server
4. **Anchor** - State hash is anchored to Bitcoin (testnet4)
5. **Verify** - Anyone can verify state authenticity from UTXO chain

## Trust Model

| Layer | Purpose |
|-------|---------|
| Git repo | Stores actual content |
| Nostr (30617) | Repo discovery + Bitcoin pubkey |
| Bitcoin UTXO | Source of truth for state |

No need to trust Nostr relays for state verification - Bitcoin is the anchor.

## Getting Started

1. Open the demo
2. Click "Edit Mode" and enter your Nostr private key
3. Generate a Bitcoin key (or enter existing)
4. Fund the address with testnet4 coins
5. Edit a note and save
6. Watch the anchor status turn green!

## State Hash

The state hash committed to Bitcoin is derived from:

```javascript
SHA256(JSON.stringify({ commit, repo, branch }))
```

This ties the git commit to the repository identity.

## License

MIT
