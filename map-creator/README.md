# Open World Map Creator

This top-level package owns geography compilation, demand normalization, road
enrichment, reproducible storage, and Artifact Set publication for every World.
World authors provide a validated directory under `worlds/`; processing code is
not copied into that directory.

The default data root is `map-creator/data`, with content-addressed sources,
resumable work, immutable artifacts, and logs in separate subdirectories. Set
`OW_MAP_DATA_ROOT` to place heavy data elsewhere without changing artifact
identity.

```powershell
$env:PYTHONPATH = 'src'
python -m open_world_map_creator plan --world ..\worlds\japan --tile JP_PREF_11
python -m open_world_map_creator build --world ..\worlds\japan --tile JP_PREF_11 --runner subprocess
```

Runner profiles select where and how the same immutable stage manifest executes.
The built-in `in-process` and `subprocess` adapters are contract-tested for
equivalent results; additional local or remote transports belong in Runner
adapters, not World Definitions.

`build` fails closed for unresolved source locks and for stages whose real inputs
have not been materialized. `publish` accepts only a run whose package output and
validation gates are complete.
