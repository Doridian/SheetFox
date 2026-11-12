{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    let
      packageJson = nixpkgs.lib.trivial.importJSON ./package.json;
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        package = pkgs.buildNpmPackage {
          pname = packageJson.name;
          version = packageJson.version;
          src = ./.;
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          # `npm run build` writes the static viewer (library included) to dist/,
          # `build:server` bundles the ingest server into dist-server/
          postBuild = ''
            npm run build:server
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share $out/lib $out/bin
            cp -r dist $out/share/sheetfox
            cp -r dist-server $out/lib/sheetfox-server
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/sheetfox-server \
              --add-flags $out/lib/sheetfox-server/server.mjs \
              --set-default SHEETFOX_STATIC_DIR $out/share/sheetfox
            runHook postInstall
          '';

          meta.mainProgram = "sheetfox-server";
        };
      in
      {
        packages.default = package;
        packages.${packageJson.name} = package;
      }
    );
}
