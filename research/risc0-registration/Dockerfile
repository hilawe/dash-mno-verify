# Container build and run for the registration prover-memory measurement.
# Recommended on macOS hosts that have docker and colima but no native Rust or
# RISC Zero toolchain. For a representative number run on a Linux host sized like
# a masternode and cap memory to model the target, for example:
#   docker build -t r0-registration .
#   docker run --rm --memory=16g r0-registration
FROM rust:1.81-bookworm

# GNU time for the peak-memory measurement, curl for the RISC Zero installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends time curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install the RISC Zero toolchain (rzup) and r0vm. Adjust if the installer path
# changes with the release, see the top-level README on version alignment.
RUN curl -L https://risczero.com/install | bash
ENV PATH="/root/.risc0/bin:${PATH}"
RUN rzup install

WORKDIR /app
COPY . .

# Prebuild so `docker run` measures a clean proving run, not a compile.
RUN cargo build --release -p host

CMD ["bash", "scripts/bench.sh"]
