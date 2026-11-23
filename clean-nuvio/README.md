# Clean Nuvio patch

`clean-nuvio.patch` turns NuvioTV into Clean Nuvio: automatic CleanStream
scene skipping on Android TV. It applies to NuvioTV commit `a740755e0f5a43874b3fee1ac808fdfc4c3884e7`:

    git clone https://github.com/NuvioMedia/NuvioTV CleanNuvio
    cd CleanNuvio
    git checkout a740755e0f5a43874b3fee1ac808fdfc4c3884e7
    git am ../clean-nuvio.patch

See CLEAN_NUVIO.md inside the patch for what it changes. NuvioTV is GPL-3.0.
