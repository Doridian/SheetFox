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

          # Static viewer: `npm run build` writes the site (library included) to dist/
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share
            cp -r dist $out/share/sheetfox
            runHook postInstall
          '';
        };
      in
      {
        packages.default = package;
        packages.${packageJson.name} = package;
      }
    );
}
