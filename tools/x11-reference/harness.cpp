/*
 * Compiled as C++ rather than C, and not by preference. The sph_*.h headers for the nine C rounds
 * carry extern "C" guards, so they resolve either way, but echo.cpp, shavite.cpp and dispatch.cpp
 * define their symbols with C++ linkage and their headers have no guards. A C harness therefore
 * cannot link against them, which is what the first attempt discovered.
 *
 * A thin command-line front end to Dash Core's own X11 rounds, so the JavaScript port in
 * common/x11/ can be checked against the implementation the network actually runs.
 *
 * It links against src/crypto/x11/ from a pinned Dash Core checkout (see Dockerfile). Nothing here
 * reimplements anything: every digest below comes from the sph_* functions in that checkout, which
 * is the whole point. If this file grew its own hashing it would be a second port, and comparing a
 * port against a port establishes nothing.
 *
 *   round <name> <hex>   one round, 64-byte digest, hex out
 *   x11 <hex>            the full chain, 32-byte result, hex out
 *
 * The chain in `x11` is written out longhand rather than looped, because the ORDER is the thing a
 * reader most needs to check by eye against Dash's HashX11.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "sph_blake.h"
#include "sph_bmw.h"
#include "sph_groestl.h"
#include "sph_jh.h"
#include "sph_keccak.h"
#include "sph_skein.h"
#include "sph_luffa.h"
#include "sph_cubehash.h"
#include "sph_shavite.h"
#include "sph_simd.h"
#include "sph_echo.h"
/* dispatch.h declares SapphireAutoDetect, which sets up the CPU-specific ECHO and SHAvite paths. */
#include "dispatch.h"

static int hex_to_bytes(const char *hex, uint8_t **out, size_t *out_len)
{
    size_t n = strlen(hex);
    if (n % 2 != 0) return 0;
    *out_len = n / 2;
    *out = (uint8_t *)malloc(*out_len ? *out_len : 1);
    if (!*out) return 0;
    for (size_t i = 0; i < *out_len; i++) {
        unsigned v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) return 0;
        (*out)[i] = (uint8_t)v;
    }
    return 1;
}

static void print_hex(const uint8_t *b, size_t n)
{
    for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
    printf("\n");
}

#define ROUND(NAME, CTX, INIT, UPDATE, CLOSE)                     \
    static void round_##NAME(const void *in, size_t len, void *out) \
    {                                                             \
        CTX ctx;                                                  \
        INIT(&ctx);                                               \
        UPDATE(&ctx, in, len);                                    \
        CLOSE(&ctx, out);                                         \
    }

ROUND(blake, sph_blake512_context, sph_blake512_init, sph_blake512, sph_blake512_close)
ROUND(bmw, sph_bmw512_context, sph_bmw512_init, sph_bmw512, sph_bmw512_close)
ROUND(groestl, sph_groestl512_context, sph_groestl512_init, sph_groestl512, sph_groestl512_close)
ROUND(jh, sph_jh512_context, sph_jh512_init, sph_jh512, sph_jh512_close)
ROUND(keccak, sph_keccak512_context, sph_keccak512_init, sph_keccak512, sph_keccak512_close)
ROUND(skein, sph_skein512_context, sph_skein512_init, sph_skein512, sph_skein512_close)
ROUND(luffa, sph_luffa512_context, sph_luffa512_init, sph_luffa512, sph_luffa512_close)
ROUND(cubehash, sph_cubehash512_context, sph_cubehash512_init, sph_cubehash512, sph_cubehash512_close)
ROUND(shavite, sph_shavite512_context, sph_shavite512_init, sph_shavite512, sph_shavite512_close)
ROUND(simd, sph_simd512_context, sph_simd512_init, sph_simd512, sph_simd512_close)
ROUND(echo, sph_echo512_context, sph_echo512_init, sph_echo512, sph_echo512_close)

struct named_round {
    const char *name;
    void (*fn)(const void *, size_t, void *);
};

static const struct named_round ROUNDS[] = {
    {"blake", round_blake},       {"bmw", round_bmw},           {"groestl", round_groestl},
    {"jh", round_jh},             {"keccak", round_keccak},     {"skein", round_skein},
    {"luffa", round_luffa},       {"cubehash", round_cubehash}, {"shavite", round_shavite},
    {"simd", round_simd},         {"echo", round_echo},
};

/* The chain, in the order Dash's HashX11 applies it. Each round consumes the previous 64-byte
 * digest, and the block's name is the first 32 bytes of the last one. */
static void x11(const void *in, size_t len, uint8_t out[32])
{
    uint8_t a[64], b[64];
    round_blake(in, len, a);
    round_bmw(a, 64, b);
    round_groestl(b, 64, a);
    round_skein(a, 64, b);
    round_jh(b, 64, a);
    round_keccak(a, 64, b);
    round_luffa(b, 64, a);
    round_cubehash(a, 64, b);
    round_shavite(b, 64, a);
    round_simd(a, 64, b);
    round_echo(b, 64, a);
    memcpy(out, a, 32);
}

int main(int argc, char **argv)
{
    /* The reference dispatches ECHO and SHAvite to CPU-specific code paths, and the pointers are
     * null until this runs. Without it the binary faults on the first ECHO. */
    SapphireAutoDetect();

    if (argc == 4 && strcmp(argv[1], "round") == 0) {
        uint8_t *in = NULL;
        size_t len = 0;
        if (!hex_to_bytes(argv[3], &in, &len)) { fprintf(stderr, "bad hex\n"); return 2; }
        for (size_t i = 0; i < sizeof(ROUNDS) / sizeof(ROUNDS[0]); i++) {
            if (strcmp(argv[2], ROUNDS[i].name) == 0) {
                uint8_t out[64];
                ROUNDS[i].fn(in, len, out);
                print_hex(out, 64);
                free(in);
                return 0;
            }
        }
        fprintf(stderr, "unknown round %s\n", argv[2]);
        free(in);
        return 2;
    }

    if (argc == 3 && strcmp(argv[1], "x11") == 0) {
        uint8_t *in = NULL;
        size_t len = 0;
        if (!hex_to_bytes(argv[2], &in, &len)) { fprintf(stderr, "bad hex\n"); return 2; }
        uint8_t out[32];
        x11(in, len, out);
        print_hex(out, 32);
        free(in);
        return 0;
    }

    /* Batch mode, one request per line, so a fuzz run of hundreds of inputs costs one process
     * rather than hundreds. Lines are "round <name> <hex>" or "x11 <hex>". */
    /* ONE LINE OUT FOR EVERY LINE IN, without exception. An unrecognised verb used to emit nothing at
     * all, so a single bad request shifted every later answer by one and the caller compared digests
     * against the wrong inputs while everything looked fine. A reviewer reproduced it with seven
     * requests and six answers. Unreachable from the current callers, and that is not a reason to
     * leave a protocol that cannot be resynchronised. */
    if (argc == 2 && strcmp(argv[1], "batch") == 0) {
        char *line = NULL;
        size_t cap = 0;
        while (getline(&line, &cap, stdin) > 0) {
            char verb[16], name[16], *hex = NULL;
            if (sscanf(line, "%15s", verb) != 1) { printf("ERR empty\n"); fflush(stdout); continue; }
            if (strcmp(verb, "round") == 0) {
                hex = (char *)malloc(strlen(line) + 1);
                hex[0] = '\0';
                /* Two fields rather than three means an EMPTY payload, which is a legitimate input:
                 * hashing the empty string is one of the vectors. Treating it as a parse failure made
                 * the harness answer nothing at all for that case, so a batch came back short and the
                 * caller could only report a count mismatch. */
                int got = sscanf(line, "%15s %15s %s", verb, name, hex);
                if (got < 2) { free(hex); printf("ERR round\n"); fflush(stdout); continue; }
                uint8_t *in = NULL; size_t len = 0;
                if (!hex_to_bytes(hex, &in, &len)) { free(hex); printf("ERR\n"); continue; }
                int done = 0;
                for (size_t i = 0; i < sizeof(ROUNDS) / sizeof(ROUNDS[0]); i++) {
                    if (strcmp(name, ROUNDS[i].name) == 0) {
                        uint8_t out[64];
                        ROUNDS[i].fn(in, len, out);
                        print_hex(out, 64);
                        done = 1;
                        break;
                    }
                }
                if (!done) printf("ERR\n");
                free(in); free(hex);
            } else if (strcmp(verb, "x11") == 0) {
                hex = (char *)malloc(strlen(line) + 1);
                hex[0] = '\0';
                if (sscanf(line, "%15s %s", verb, hex) < 1) { free(hex); printf("ERR x11\n"); fflush(stdout); continue; }
                uint8_t *in = NULL; size_t len = 0;
                if (!hex_to_bytes(hex, &in, &len)) { free(hex); printf("ERR\n"); continue; }
                uint8_t out[32];
                x11(in, len, out);
                print_hex(out, 32);
                free(in); free(hex);
            } else {
                /* An unknown verb still answers, so the caller's line count and answer count agree
                 * and the mismatch is visible as a value rather than as silent misalignment. */
                printf("ERR verb\n");
            }
            fflush(stdout);
        }
        free(line);
        return 0;
    }

    fprintf(stderr, "usage: %s round <name> <hex> | %s x11 <hex> | %s batch\n", argv[0], argv[0], argv[0]);
    return 2;
}
