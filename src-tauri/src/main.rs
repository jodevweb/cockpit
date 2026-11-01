// La fenêtre est la seule interface : pas de console derrière en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	cockpit_lib::run()
}
