#![no_main]

sp1_zkvm::entrypoint!(main);

use payload_event_batch_lib::{verify_witness, BatchWitness};

pub fn main() {
    let bytes = sp1_zkvm::io::read::<Vec<u8>>();
    let witness: BatchWitness = serde_json::from_slice(&bytes).expect("valid batch witness");
    let public_values = verify_witness(&witness);
    let encoded = serde_json::to_vec(&public_values).expect("serializable public values");
    sp1_zkvm::io::commit_slice(&encoded);
}
