FROM python:3.13.9-slim-trixie

ARG DEPOT_COMMIT=ef4ab40dce4b3787e4c994f6c426ddd637d30f05
ARG MAPSHAPER_VERSION=0.7.51
ARG PMTILES_VERSION=1.31.2
ARG PLANETILER_VERSION=0.10.2
ARG TIPPECANOE_VERSION=2.79.0

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential ca-certificates curl gdal-bin git jq libsqlite3-dev \
       nodejs npm openjdk-21-jre-headless osmium-tool sqlite3 zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "mapshaper@${MAPSHAPER_VERSION}"

RUN git clone --depth 1 --branch "${TIPPECANOE_VERSION}" \
      https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && make -C /tmp/tippecanoe -j2 \
    && make -C /tmp/tippecanoe install \
    && rm -rf /tmp/tippecanoe

RUN curl --fail --location --retry 3 \
      "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
      --output /tmp/pmtiles.tar.gz \
    && tar -xzf /tmp/pmtiles.tar.gz -C /usr/local/bin pmtiles \
    && chmod +x /usr/local/bin/pmtiles \
    && rm /tmp/pmtiles.tar.gz

RUN curl --fail --location --retry 3 \
      "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar" \
      --output /usr/local/bin/planetiler.jar \
    && echo "f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d  /usr/local/bin/planetiler.jar" | sha256sum --check \
    && chmod +x /usr/local/bin/planetiler.jar

RUN python -m pip install --no-cache-dir \
      duckdb==1.5.3 geopandas==1.1.1 "httpx[http2]==0.28.1" inflect==7.5.0 \
      mapbox-vector-tile==2.2.0 matplotlib==3.10.9 mercantile==1.2.1 \
      netcdf4==1.7.4 numpy==2.3.5 osmnx==2.1.0 pandas==2.3.3 \
      scipy==1.17.1 shapely==2.1.2 tqdm==4.68.2 unidecode==1.4.0 \
      xarray==2026.4.0

RUN git clone https://github.com/Subway-Builder-Modded/depot.git /opt/depot \
    && git -C /opt/depot checkout "${DEPOT_COMMIT}" \
    && python -m pip install --no-cache-dir /opt/depot \
    && test "$(git -C /opt/depot rev-parse HEAD)" = "${DEPOT_COMMIT}"

WORKDIR /work
