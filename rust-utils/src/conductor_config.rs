#![deny(clippy::all)]

use holochain_conductor_api::{
  conductor::{paths::DataRootPath, ConductorConfig, KeystoreConfig},
  AdminInterfaceConfig, InterfaceDriver,
};
use holochain_p2p::kitsune_p2p::dependencies::kitsune_p2p_types::config::{
  tuning_params_struct::KitsuneP2pTuningParams, KitsuneP2pConfig, TransportConfig,
};
use std::path::{Path, PathBuf};

#[napi]
pub fn default_conductor_config(
  admin_port: u16,
  conductor_environment_path: String,
  keystore_connection_url: String,
  bootstrap_server_url: String,
  signaling_server_url: String,
) -> String {
  let mut network_config = KitsuneP2pConfig::default();
  network_config.bootstrap_service = Some(url2::url2!("{}", bootstrap_server_url));

  let tuning_params = KitsuneP2pTuningParams::default();

  network_config.tuning_params = std::sync::Arc::new(tuning_params);

  network_config.transport_pool.push(TransportConfig::WebRTC {
    signal_url: signaling_server_url,
  });

  let config = ConductorConfig {
    data_root_path: Some(DataRootPath::from(PathBuf::from(Path::new(
      &conductor_environment_path,
    )))),
    dpki: None,
    keystore: KeystoreConfig::LairServer {
      connection_url: url2::url2!("{}", keystore_connection_url),
    },
    admin_interfaces: Some(vec![AdminInterfaceConfig {
      driver: InterfaceDriver::Websocket { port: admin_port },
    }]),
    network: network_config,
    db_sync_strategy: Default::default(),
    tracing_override: None,
    tuning_params: None,
  };

  serde_yaml::to_string(&config).expect("Failed to convert conductor config to yaml string.")
}

// overwrite conductor config
