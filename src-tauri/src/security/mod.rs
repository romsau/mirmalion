//! Ce qui touche aux secrets : la clé de chiffrement de la base, et rien d'autre.
//!
//! # Pièges
//!
//! - ⚠️ Aucun élément de ce module ne doit être exposé en IPC. Le webview est traité comme non
//!   fiable ; il n'a aucune raison de voir la clé, ni même de savoir qu'elle existe.

pub mod key;
