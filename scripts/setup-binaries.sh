#!/bin/bash

REQUIRED_HOLOCHAIN_VERSION="0.2.5-rc.0"
REQUIRED_LAIR_VERSION="0.3.0"

# Check that this script is being run from the right location
if [ ! -f "package.json" ] || [ ! -f "electron-builder.yml" ];
then
    echo "Error: You must run this script in the root directory of the launcher repository."
    exit 1
fi

# Check wheter cargo is available
if [ ! command -v cargo &> /dev/null ] || [ ! command -v rustc &> /dev/null ];
then
    echo "Error: You need to install Rust first."
    exit 1
fi

# get target architecture triple, e.g. unknown-linux-gnu on Ubuntu 22.04
# TARGET_TRIPLE=$(rustc -vV | sed -n 's/^.*host: \(.*\)*$/\1/p')

# create resources/bins if id doesn't exist
if [ ! -d resources/bins ];
    then mkdir resources/bins
fi

# check whether correct holochain binary is already in the resources/bins folder
if [ -f "resources/bins/holochain-v${REQUIRED_HOLOCHAIN_VERSION}" ];
    then echo "Required holochain binary already installed."
    else
    	echo "Installing required holochain binary from crates.io"
    	echo "Running command 'cargo install holochain --version $REQUIRED_HOLOCHAIN_VERSION --locked --features sqlite-encrypted'"
        cargo install holochain --version $REQUIRED_HOLOCHAIN_VERSION --locked --features sqlite-encrypted
        echo "Copying holochain binary to resources/bins folder."
        HOLOCHAIN_PATH=$(which holochain)
        cp $HOLOCHAIN_PATH resources/bins/holochain-v${REQUIRED_HOLOCHAIN_VERSION}
fi

# check whether correct lair binary is already in the resources/bins folder
if [ -f "resources/bins/lair-keystore-v${REQUIRED_LAIR_VERSION}" ];

    then echo "Required lair-keystore binary already installed."
    else
    	echo "Installing required lair-keystore binary from crates.io"
    	echo "Running command 'cargo install lair-keystore --version $REQUIRED_LAIR_VERSION --locked'"
        cargo install  lair_keystore --version $REQUIRED_LAIR_VERSION --locked
        echo "Copying lair-keystore binary to resources/bins folder."
        LAIR_PATH=$(which lair-keystore)
        cp $LAIR_PATH resources/bins/lair-keystore-v${REQUIRED_LAIR_VERSION}
fi

echo "done."