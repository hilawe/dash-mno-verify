# The X11 reference, built from a PINNED Dash Core checkout.
#
# The point of this image is provenance. The digests it prints come from the same C that the network
# runs, fetched from upstream at a tag recorded here, rather than from anything this repository wrote
# or vendored. A reviewer who wants to know where the vectors came from reads this file and the tag.
#
# Linux rather than the host, for the project's usual reason: the toolchain is predictable here, and
# nothing about the host's compiler or its endianness assumptions leaks into the result.
FROM debian:bookworm-slim

# The pin. The committed vectors in test/vectors/x11_round_vectors.json were produced at this tag, and
# changing it should be a deliberate commit of its own, with the regenerated vectors alongside it so
# the diff shows whether upstream changed anything the port has to follow.
ARG DASH_TAG=v23.1.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# THE COMMIT IS THE PIN, and the tag is only how it is found.
#
# A git tag is mutable. Upstream can move or re-cut one, so a clean rebuild years from now was not
# guaranteed to compile the source the committed vectors were derived from, which is the one property
# this whole directory exists to provide. A reviewer pointed out that the image already RECORDED the
# commit and then did not use it.
#
# So the tag is fetched, the resulting commit is checked against DASH_COMMIT, and a mismatch fails the
# build rather than quietly producing a reference built from something else. Passing DASH_COMMIT empty
# is the deliberate escape for moving the pin: the build then records whatever the tag resolved to and
# prints it, which is the value to write into PIN.
ARG DASH_COMMIT=8f06d39897babc4c4d28598af9426f483e3c5596

RUN set -eu; \
    git clone --depth 1 --branch "${DASH_TAG}" https://github.com/dashpay/dash.git dashcore; \
    GOT="$(git -C dashcore rev-parse HEAD)"; \
    if [ -n "${DASH_COMMIT}" ] && [ "${GOT}" != "${DASH_COMMIT}" ]; then \
      echo "PIN MISMATCH: tag ${DASH_TAG} now resolves to ${GOT}, not the pinned ${DASH_COMMIT}."; \
      echo "A tag moved upstream. Decide whether to follow it before regenerating anything."; \
      exit 1; \
    fi; \
    echo "${GOT}" > /build/REFERENCE_COMMIT; \
    echo "${DASH_TAG}" > /build/REFERENCE_TAG; \
    echo "reference pinned at ${GOT}"

COPY harness.cpp /build/harness.cpp

# Compiled against the upstream sources in place. The include path points into the checkout so the
# sph_*.h headers resolve exactly as they do in a Dash build, and -I. lets harness.c include them by
# bare name.
#
# The C++ files (aes, echo, shavite, dispatch) are compiled as C++ and linked with the C ones, which
# is why the link runs through g++.
RUN set -eu; \
    X11=dashcore/src/crypto/x11; \
    g++ -O2 -std=c++20 -I dashcore/src -I "$X11" -c "$X11"/aes.cpp "$X11"/echo.cpp "$X11"/shavite.cpp "$X11"/dispatch.cpp; \
    gcc -O2 -I dashcore/src -I "$X11" -c "$X11"/blake.c "$X11"/bmw.c "$X11"/groestl.c "$X11"/jh.c \
        "$X11"/keccak.c "$X11"/skein.c "$X11"/luffa.c "$X11"/cubehash.c "$X11"/simd.c; \
    g++ -O2 -std=c++20 -I dashcore/src -I "$X11" -c harness.cpp -o harness.o; \
    g++ -O2 -o /usr/local/bin/x11ref harness.o aes.o echo.o shavite.o dispatch.o blake.o bmw.o \
        groestl.o jh.o keccak.o skein.o luffa.o cubehash.o simd.o

# A build that produces a binary which cannot run is not worth shipping, so the image refuses to
# finish rather than leaving that to be discovered later. This only proves the binary executes and
# every round dispatches; whether it agrees with the JavaScript port is what regenerate.sh and fuzz.sh
# on the host decide, against the real block headers committed to the repository.
RUN set -eu; \
    echo "reference commit: $(cat /build/REFERENCE_COMMIT)"; \
    x11ref x11 00 > /dev/null; \
    for r in blake bmw groestl jh keccak skein luffa cubehash shavite simd echo; do \
      x11ref round "$r" 00 > /dev/null || { echo "round $r does not run"; exit 1; }; \
    done

ENTRYPOINT ["x11ref"]
