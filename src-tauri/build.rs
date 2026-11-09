fn main() {
	// Sous Windows, le manifeste qui active les contrôles communs v6 est
	// indispensable : sans lui, un binaire qui embarque Tauri ne démarre pas
	// (`STATUS_ENTRYPOINT_NOT_FOUND`). `tauri-build` ne le lie qu'à l'exécutable
	// de l'app ; on le lie nous-mêmes à tout ce que le linker MSVC produit, tests
	// compris, et on retire celui de `tauri-build` pour ne pas l'avoir en double.
	let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
	let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
	let mut attributes = tauri_build::Attributes::new();
	if target_os == "windows" && target_env == "msvc" {
		let manifest =
			std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
		println!("cargo:rerun-if-changed={}", manifest.display());
		println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
		println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
		attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
	}
	tauri_build::try_build(attributes).expect("le script de compilation de Tauri a échoué");
}
