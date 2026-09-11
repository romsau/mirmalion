//! Point d'entrée de l'exécutable : il ne fait qu'appeler [`app_lib::run`].
//!
//! # Pièges
//!
//! - ⚠️ L'attribut `windows_subsystem` ne se retire pas : sans lui, une console s'ouvre en plus
//!   de la fenêtre dans un build de release sous Windows.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  app_lib::run();
}
