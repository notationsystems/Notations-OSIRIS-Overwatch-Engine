use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const LEAF_DOMAIN: &str = "payload.event_batch.leaf.v1";
const NODE_DOMAIN: &str = "payload.event_batch.node.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessEvent {
    pub sequence: u64,
    pub stream: String,
    pub event_id: String,
    pub operation_id: String,
    pub kind: String,
    pub recorded_at: String,
    pub command_hash: String,
    pub previous_hash: Option<String>,
    pub record_hash: String,
    pub canonical_event_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchWitness {
    pub schema: String,
    pub batch_id: String,
    pub from_sequence: u64,
    pub to_sequence: u64,
    pub event_count: u64,
    pub expected_root: String,
    pub prior_hashes: BTreeMap<String, Option<String>>,
    pub events: Vec<WitnessEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicValues {
    pub program: String,
    pub batch_id: String,
    pub from_sequence: u64,
    pub to_sequence: u64,
    pub event_count: u64,
    pub root: String,
    pub final_hashes: BTreeMap<String, Option<String>>,
}

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn stream_domain(stream: &str) -> &'static str {
    match stream {
        "load_operation" => "payload.load_operations.record.v1",
        "carrier_communication" => "payload.carrier_communications.record.v1",
        "procurement" => "payload.procurement.record.v1",
        "commercial" => "payload.commercial.record.v1",
        "project_cargo" => "payload.project_cargo.record.v1",
        _ => panic!("unknown event stream"),
    }
}

fn json_string<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing event field {key}"))
}

pub fn verify_witness(witness: &BatchWitness) -> PublicValues {
    assert_eq!(witness.schema, "payload.event_batch.witness.v1");
    assert!(!witness.events.is_empty());
    assert_eq!(witness.event_count as usize, witness.events.len());
    assert_eq!(witness.events[0].sequence, witness.from_sequence);
    assert_eq!(witness.events.last().unwrap().sequence, witness.to_sequence);
    assert_eq!(
        witness.to_sequence - witness.from_sequence + 1,
        witness.event_count
    );

    let mut stream_hashes = witness.prior_hashes.clone();
    let mut leaves = Vec::with_capacity(witness.events.len());
    for (offset, event) in witness.events.iter().enumerate() {
        assert_eq!(event.sequence, witness.from_sequence + offset as u64);
        assert_eq!(event.command_hash.len(), 64);
        assert_eq!(event.record_hash.len(), 64);
        let parsed: Value =
            serde_json::from_str(&event.canonical_event_json).expect("canonical event JSON");
        assert_eq!(json_string(&parsed, "eventId"), event.event_id);
        assert_eq!(json_string(&parsed, "operationId"), event.operation_id);
        assert_eq!(json_string(&parsed, "kind"), event.kind);
        assert_eq!(json_string(&parsed, "recordedAt"), event.recorded_at);
        assert_eq!(json_string(&parsed, "commandHash"), event.command_hash);
        let expected_previous = stream_hashes.get(&event.stream).cloned().unwrap_or(None);
        assert_eq!(event.previous_hash, expected_previous);
        let previous = event.previous_hash.as_deref().unwrap_or("GENESIS");
        let expected_record = digest(&format!(
            "{}|{}|{}",
            stream_domain(&event.stream),
            previous,
            event.canonical_event_json
        ));
        assert_eq!(event.record_hash, expected_record);
        stream_hashes.insert(event.stream.clone(), Some(event.record_hash.clone()));
        leaves.push(digest(&format!(
            "{}|{}|{}|{}",
            LEAF_DOMAIN, event.sequence, event.stream, event.record_hash
        )));
    }

    let mut level = leaves;
    while level.len() > 1 {
        let mut next = Vec::with_capacity((level.len() + 1) / 2);
        for pair in level.chunks(2) {
            next.push(if pair.len() == 2 {
                digest(&format!("{}|{}|{}", NODE_DOMAIN, pair[0], pair[1]))
            } else {
                pair[0].clone()
            });
        }
        level = next;
    }
    assert_eq!(level[0], witness.expected_root);
    PublicValues {
        program: "payload_event_batch_v1".to_string(),
        batch_id: witness.batch_id.clone(),
        from_sequence: witness.from_sequence,
        to_sequence: witness.to_sequence,
        event_count: witness.event_count,
        root: level[0].clone(),
        final_hashes: stream_hashes,
    }
}

#[cfg(test)]
mod tests {
    use super::{digest, verify_witness, BatchWitness};

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn shared_typescript_fixture_reconstructs_the_committed_root() {
        let witness: BatchWitness =
            serde_json::from_str(include_str!("../../fixtures/event-batch.json")).unwrap();
        let expected = witness.expected_root.clone();
        let values = verify_witness(&witness);
        assert_eq!(values.root, expected);
        assert_eq!(
            values.final_hashes["load_operation"],
            Some(witness.events[0].record_hash.clone())
        );
    }
}
