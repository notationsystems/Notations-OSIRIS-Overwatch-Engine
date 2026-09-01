use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use payload_event_batch_lib::PublicValues;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{EnvProver, EnvProvingKey, ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1ProofWithPublicValues, SP1Stdin,
};
use std::{fs, path::PathBuf};

const ELF: Elf = include_elf!("payload-event-batch-program");

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum ProofMode {
    Core,
    Compressed,
    Groth16,
    Plonk,
}

#[derive(Parser)]
#[command(name = "payload-sp1-worker")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Prove {
        #[arg(long)]
        witness: PathBuf,
        #[arg(long)]
        proof: PathBuf,
        #[arg(long, value_enum)]
        mode: ProofMode,
    },
    Verify {
        #[arg(long)]
        proof: PathBuf,
        #[arg(long)]
        result: PathBuf,
        #[arg(long)]
        expected_vkey: String,
    },
    Vkey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedResult {
    proof_id: String,
    verification_key: String,
    proof_mode: ProofMode,
    public_values: PublicValues,
}

fn setup() -> Result<(EnvProver, EnvProvingKey)> {
    let client = ProverClient::from_env();
    let key = client.setup(ELF).context("SP1 program setup")?;
    Ok((client, key))
}

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    match Cli::parse().command {
        Command::Vkey => {
            let (_, key) = setup()?;
            println!("{}", key.verifying_key().bytes32());
        }
        Command::Prove {
            witness,
            proof,
            mode,
        } => {
            let (client, key) = setup()?;
            let mut stdin = SP1Stdin::new();
            stdin.write(&fs::read(witness).context("read witness")?);
            let artifact = match mode {
                ProofMode::Core => client.prove(&key, stdin).run(),
                ProofMode::Compressed => client.prove(&key, stdin).compressed().run(),
                ProofMode::Groth16 => client.prove(&key, stdin).groth16().run(),
                ProofMode::Plonk => client.prove(&key, stdin).plonk().run(),
            }
            .context("generate SP1 proof")?;
            artifact.save(proof).context("save SP1 proof")?;
        }
        Command::Verify {
            proof,
            result,
            expected_vkey,
        } => {
            let (client, key) = setup()?;
            let actual_vkey = key.verifying_key().bytes32();
            if actual_vkey != expected_vkey {
                bail!(
                    "verification key mismatch: expected {expected_vkey}, program is {actual_vkey}"
                );
            }
            let artifact = SP1ProofWithPublicValues::load(&proof).context("load SP1 proof")?;
            client
                .verify(&artifact, key.verifying_key(), None)
                .context("verify SP1 proof")?;
            let public_values: PublicValues =
                serde_json::from_slice(artifact.public_values.as_slice())
                    .context("decode committed public values")?;
            let bytes = fs::read(&proof).context("hash SP1 proof")?;
            let proof_id = format!("sp1:{}", hex::encode(Sha256::digest(&bytes)));
            let proof_mode = match proof
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
            {
                _ if proof.to_string_lossy().contains(".compressed.") => ProofMode::Compressed,
                _ if proof.to_string_lossy().contains(".groth16.") => ProofMode::Groth16,
                _ if proof.to_string_lossy().contains(".plonk.") => ProofMode::Plonk,
                _ => ProofMode::Core,
            };
            fs::write(
                result,
                serde_json::to_vec_pretty(&VerifiedResult {
                    proof_id,
                    verification_key: actual_vkey,
                    proof_mode,
                    public_values,
                })?,
            )
            .context("write verified result")?;
        }
    }
    Ok(())
}
