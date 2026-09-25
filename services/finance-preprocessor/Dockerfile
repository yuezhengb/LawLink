FROM python:3.12.14-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/tmp

COPY requirements.txt /tmp/finance-preprocessor-requirements.txt

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ghostscript \
        libreoffice-calc-nogui \
        poppler-utils \
        qpdf \
        tesseract-ocr \
        tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install -r /tmp/finance-preprocessor-requirements.txt

RUN groupadd --system --gid 65532 finance-worker \
    && useradd --system --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin finance-worker \
    && mkdir -p /srv/finance-preprocessor \
    && chown 65532:65532 /srv/finance-preprocessor

WORKDIR /srv/finance-preprocessor
COPY --chown=65532:65532 app.py ./app.py
USER 65532:65532

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"

CMD ["python", "-u", "app.py"]
