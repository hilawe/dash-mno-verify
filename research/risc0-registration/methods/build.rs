// Compiles the guest and emits REGISTRATION_ELF and REGISTRATION_ID into OUT_DIR,
// derived from the guest binary name "registration" in methods/guest/Cargo.toml.
fn main() {
    risc0_build::embed_methods();
}
