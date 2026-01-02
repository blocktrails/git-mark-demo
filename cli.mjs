#!/usr/bin/env node
// GitMark CLI - test Bitcoin anchoring flow

import * as blocktrails from '/home/melvin/remote/github.com/blocktrails/blocktrails/src/index.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

// Config
const PRIVKEY = process.env.GITMARK_KEY || '07f689807708ca937e1fdbea750ea70802fdec379f890306f6dc4716d0798948';
const NETWORK = 'testnet4';
const REPO_ID = 'gitmark';
const BRANCH = 'main';

// bech32m helpers
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [], maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function pubkeyToAddress(xonlyPubkey) {
  const hrp = 'tb';
  const data = [1, ...convertBits(xonlyPubkey, 8, 5, true)];
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map(d => CHARSET[d]).join('');
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchUTXOs(address) {
  const res = await fetch(`https://mempool.space/testnet4/api/address/${address}/utxo`);
  return res.json();
}

async function broadcastTx(txHex) {
  const res = await fetch('https://mempool.space/testnet4/api/tx', {
    method: 'POST',
    body: txHex
  });
  return res.text();
}

function hashState(commit) {
  const stateObj = { commit, repo: REPO_ID, branch: BRANCH };
  const json = JSON.stringify(stateObj);
  return createHash('sha256').update(json).digest('hex');
}

// Load trail from file
function loadTrail(trailPath) {
  if (existsSync(trailPath)) {
    return JSON.parse(readFileSync(trailPath, 'utf8'));
  }
  return null;
}

// Save trail to file
function saveTrail(trailPath, trail) {
  const dir = trailPath.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(trailPath, JSON.stringify(trail, null, 2));
}

// Main
async function main() {
  const cmd = process.argv[2] || 'status';

  const bt = new blocktrails.Blocktrail(PRIVKEY);
  const pubkeyBase = bt.pubkeyBase;
  const baseXonly = blocktrails.p2trXonly(pubkeyBase);
  const baseAddress = pubkeyToAddress(baseXonly);

  console.log('GitMark CLI');
  console.log('===========');
  console.log('Pubkey:', bytesToHex(pubkeyBase));
  console.log('Base address:', baseAddress);
  console.log('');

  const trailPath = '.gitmark/trail.json';
  let trail = loadTrail(trailPath);

  if (cmd === 'status') {
    // Check base address
    console.log('Checking base address...');
    const baseUtxos = await fetchUTXOs(baseAddress);

    if (baseUtxos.length > 0) {
      const total = baseUtxos.reduce((sum, u) => sum + u.value, 0);
      console.log(`✓ Base: ${total} sats (${baseUtxos.length} UTXOs)`);
      console.log('  Status: Ready to anchor');
    } else {
      console.log('✗ Base: No funds');
    }

    // Check trail
    if (trail && trail.anchors.length > 0) {
      console.log(`\nTrail: ${trail.anchors.length} anchors`);

      // Check each position on trail (most recent first)
      for (let i = trail.anchors.length - 1; i >= 0; i--) {
        const anchor = trail.anchors[i];
        const chain = trail.anchors.slice(0, i + 1).map(a => hexToBytes(a.stateHash));
        const derivedPubkey = blocktrails.deriveChainedPubkey(pubkeyBase, chain);
        const xonly = blocktrails.p2trXonly(derivedPubkey);
        const address = pubkeyToAddress(xonly);
        const utxos = await fetchUTXOs(address);

        if (utxos.length > 0) {
          const total = utxos.reduce((sum, u) => sum + u.value, 0);
          console.log(`✓ Anchor ${i}: ${total} sats @ ${anchor.commit.substring(0, 7)}`);
          console.log(`  Address: ${address}`);
          console.log(`  TXID: ${anchor.txid}`);

          // Check if matches current commit
          try {
            const currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
            if (anchor.commit === currentCommit) {
              console.log(`  Status: ✓ Anchored (matches current commit)`);
            } else {
              console.log(`  Status: ⚠ Stale (current: ${currentCommit.substring(0, 7)})`);
            }
          } catch (e) {}
          break;
        } else {
          console.log(`✗ Anchor ${i}: spent (${anchor.commit.substring(0, 7)})`);
        }
      }
    } else {
      console.log('\nNo trail file found');
    }

    // Get current git commit
    try {
      const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      console.log(`\nCurrent commit: ${commit.substring(0, 7)}`);
      const stateHash = hashState(commit);
      console.log(`State hash: ${stateHash.substring(0, 16)}...`);
    } catch (e) {
      console.log('\nNot in a git repo');
    }

  } else if (cmd === 'anchor') {
    // Get current commit
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    console.log('Anchoring commit:', commit.substring(0, 7));

    const stateHash = hashState(commit);
    const stateHashBytes = hexToBytes(stateHash);
    console.log('State hash:', stateHash.substring(0, 16) + '...');

    // Build anchor chain from trail
    const anchorChain = trail ? trail.anchors.map(a => a.stateHash) : [];

    // Determine from/to
    let fromPubkey, toPubkey, signingKey;
    const privkeyBytes = hexToBytes(PRIVKEY);

    if (anchorChain.length === 0) {
      fromPubkey = pubkeyBase;
      toPubkey = blocktrails.derivePubkey(pubkeyBase, stateHashBytes);
      signingKey = blocktrails.adjustPrivkeyForSigning(privkeyBytes, fromPubkey);
    } else {
      const chainBytes = anchorChain.map(h => hexToBytes(h));
      fromPubkey = blocktrails.deriveChainedPubkey(pubkeyBase, chainBytes);
      toPubkey = blocktrails.deriveChainedPubkey(pubkeyBase, [...chainBytes, stateHashBytes]);
      const derivedPrivkey = blocktrails.deriveChainedPrivkey(privkeyBytes, chainBytes);
      signingKey = blocktrails.adjustPrivkeyForSigning(derivedPrivkey, fromPubkey);
    }

    const fromXonly = blocktrails.p2trXonly(fromPubkey);
    const toXonly = blocktrails.p2trXonly(toPubkey);
    const fromAddress = pubkeyToAddress(fromXonly);
    const toAddress = pubkeyToAddress(toXonly);

    console.log('From:', fromAddress);
    console.log('To:', toAddress);

    // Get UTXOs
    const utxos = await fetchUTXOs(fromAddress);
    if (utxos.length === 0) {
      console.log('✗ No funds at source address');
      process.exit(1);
    }

    const utxo = utxos.reduce((a, b) => a.value > b.value ? a : b);
    const fee = 300;
    const outputValue = utxo.value - fee;

    console.log('Input:', utxo.value, 'sats');
    console.log('Output:', outputValue, 'sats (fee:', fee, ')');

    // Build tx
    const tx = blocktrails.buildTransaction({
      inputs: [{ txid: utxo.txid, vout: utxo.vout, amount: utxo.value, witnessProgram: fromXonly }],
      outputs: [{ scriptPubKey: new Uint8Array([0x51, 0x20, ...toXonly]), value: outputValue }]
    });

    const prevouts = [{ txid: utxo.txid, vout: utxo.vout, witnessProgram: fromXonly, amount: utxo.value }];
    const signed = blocktrails.signTransaction(tx, [signingKey], prevouts);
    const txBytes = blocktrails.serializeTransaction(signed);
    const txHex = bytesToHex(txBytes);

    console.log('\nBroadcasting...');
    const txid = await broadcastTx(txHex);

    if (txid.length === 64) {
      console.log('✓ Broadcast success!');
      console.log('TXID:', txid);
      console.log('View:', `https://mempool.space/testnet4/tx/${txid}`);

      // Update trail
      if (!trail) {
        trail = {
          network: NETWORK,
          pubkey: bytesToHex(pubkeyBase),
          genesis: `${utxo.txid}:${utxo.vout}`,
          anchors: []
        };
      }
      trail.anchors.push({
        commit,
        stateHash,
        txid,
        vout: 0,
        timestamp: new Date().toISOString()
      });

      saveTrail(trailPath, trail);
      console.log('\n✓ Trail saved to', trailPath);

    } else {
      console.log('✗ Broadcast failed:', txid);
      process.exit(1);
    }

  } else if (cmd === 'fund') {
    // Show funding address
    console.log('Send testnet4 coins to:');
    console.log(baseAddress);
    console.log('\nFaucets:');
    console.log('- https://mempool.space/testnet4/faucet');

  } else {
    console.log('Commands:');
    console.log('  status  - Show current anchor status');
    console.log('  anchor  - Anchor current commit to Bitcoin');
    console.log('  fund    - Show address for funding');
  }
}

main().catch(console.error);
