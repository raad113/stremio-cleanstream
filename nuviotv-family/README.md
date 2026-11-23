# NuvioTv-Family patch

`nuviotv-family.patch` turns NuvioTV into NuvioTv-Family: automatic CleanStream
scene skipping on Android TV. It applies to NuvioTV commit `a740755e0f5a43874b3fee1ac808fdfc4c3884e7`:

    git clone https://github.com/NuvioMedia/NuvioTV NuvioTv-Family
    cd NuvioTv-Family
    git checkout a740755e0f5a43874b3fee1ac808fdfc4c3884e7
    git am ../nuviotv-family.patch

See NUVIOTV_FAMILY.md inside the patch for what it changes. NuvioTV is GPL-3.0.
