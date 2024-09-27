FROM python:3.13.0rc2-slim-bullseye

COPY requirements3.txt /tmp/requirements3.txt

RUN \
  pip3 install -r /tmp/requirements3.txt

RUN \
  apt-get update && \
  apt-get install -y faketime

RUN useradd --shell /bin/bash sandbox
USER sandbox
WORKDIR /
