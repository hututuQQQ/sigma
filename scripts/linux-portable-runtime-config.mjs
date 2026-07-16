export const linuxBrokerBuilderImage = "rust:1.96.0-alpine3.22@sha256:96cfa1f2d5a86b3b0d54e4415c6c7f9865fb25762fe2b016abfdd487d8179352";
export const linuxSysrootImage = "gcc:8-buster@sha256:4717f1177825f3e6b08171d9d4355f9f599a968477805b0c7abd81d013a1e84d";
export const linuxCompatibilityImage = "rockylinux:8@sha256:2d05a9266523bbf24f33ebc3a9832e4d5fd74b973c220f2204ca802286aa275d";
export const linuxCompatibilityImages = Object.freeze([
  Object.freeze({
    name: "rocky-linux-8",
    image: linuxCompatibilityImage
  }),
  Object.freeze({
    name: "ubuntu-20.04",
    image: "ubuntu:20.04@sha256:c664f8f86ed5a386b0a340d981b8f81714e21a8b9c73f658c4bea56aa179d54a"
  }),
  Object.freeze({
    name: "debian-12-slim",
    image: "debian:12-slim@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e"
  })
]);
export const patchelfRelease = Object.freeze({
  version: "0.18.0",
  url: "https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0-x86_64.tar.gz",
  sha256: "ce84f2447fb7a8679e58bc54a20dc2b01b37b5802e12c57eece772a6f14bf3f0"
});
export const linuxMinimumGlibc = "2.28";
export const linuxNodeRpath = "$ORIGIN/../lib";
export const bubblewrapRelease = Object.freeze({
  version: "0.4.0-2.el8_10",
  url: "https://dl.rockylinux.org/pub/rocky/8.10/BaseOS/x86_64/os/Packages/b/bubblewrap-0.4.0-2.el8_10.x86_64.rpm",
  sha256: "2899b655f4be66eac7534acc35858209ac1a0be12117a95aa8294ad4f14bce75"
});
export const linuxRuntimeLibraryNames = Object.freeze([
  "libatomic.so.1", "libstdc++.so.6", "libgcc_s.so.1",
  "libselinux.so.1", "libcap.so.2", "libpcre2-8.so.0"
]);

export function assertLinuxRuntimeLibraryInventory(entries, label = "Linux portable runtime") {
  const list = Array.isArray(entries) ? entries : [];
  const names = list.map((entry) => entry?.name);
  const exact = list.length === linuxRuntimeLibraryNames.length
    && new Set(names).size === names.length
    && linuxRuntimeLibraryNames.every((name) => names.includes(name));
  if (!exact) {
    throw new Error(`${label} must include exactly: ${linuxRuntimeLibraryNames.join(", ")}.`);
  }
  return list;
}
