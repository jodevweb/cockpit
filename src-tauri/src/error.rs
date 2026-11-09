use serde::Serialize;

/// Erreur transportable vers le webview. On garde volontairement un message
/// lisible côté UI plutôt qu'un dump technique : chaque écran affiche l'erreur
/// telle quelle dans son bandeau.
#[derive(Debug, thiserror::Error)]
pub enum CockpitError {
	#[error("{0}")]
	Message(String),
	#[error("{}", crate::i18n::tf("error.missingCredential", &[("service", .service)]))]
	MissingCredential { service: String },
	#[error("{0}")]
	Io(#[from] std::io::Error),
	#[error("{}", crate::i18n::tf("error.network", &[("error", .0)]))]
	Http(#[from] reqwest::Error),
	#[error("{0}")]
	Other(#[from] anyhow::Error),
}

impl CockpitError {
	pub fn msg(value: impl Into<String>) -> Self {
		Self::Message(value.into())
	}

	pub fn missing(service: impl Into<String>) -> Self {
		Self::MissingCredential {
			service: service.into(),
		}
	}
}

impl Serialize for CockpitError {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
		serializer.serialize_str(&self.to_string())
	}
}

pub type Result<T> = std::result::Result<T, CockpitError>;
