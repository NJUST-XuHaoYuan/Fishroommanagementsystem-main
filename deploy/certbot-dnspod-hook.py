#!/usr/bin/env python3

import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ZONE = os.environ.get("DNSPOD_ZONE", "marineforest.com.cn")
CONTAINER = os.environ.get("FISHROOM_BACKEND_CONTAINER", "fishroom-backend")
STATE_DIR = Path("/var/lib/letsencrypt/dnspod-hooks")
API_HOST = "dnspod.tencentcloudapi.com"
API_VERSION = "2021-03-23"
CONTENT_TYPE = "application/json; charset=utf-8"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hmac_sha256(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).digest()


def credentials() -> tuple[str, str]:
    output = subprocess.run(
        [
            "docker",
            "inspect",
            CONTAINER,
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    secret_id = values.get("COS_SECRET_ID", "")
    secret_key = values.get("COS_SECRET_KEY", "")
    if not secret_id or not secret_key:
        raise RuntimeError(f"{CONTAINER} does not expose COS_SECRET_ID/COS_SECRET_KEY")
    return secret_id, secret_key


def call_api(action: str, payload: dict) -> dict:
    secret_id, secret_key = credentials()
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    timestamp = int(time.time())
    date = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
    signed_headers = "content-type;host;x-tc-action"
    canonical_headers = (
        f"content-type:{CONTENT_TYPE}\n"
        f"host:{API_HOST}\n"
        f"x-tc-action:{action.lower()}\n"
    )
    canonical_request = (
        "POST\n/\n\n"
        f"{canonical_headers}\n{signed_headers}\n{sha256(body)}"
    )
    credential_scope = f"{date}/dnspod/tc3_request"
    string_to_sign = (
        "TC3-HMAC-SHA256\n"
        f"{timestamp}\n{credential_scope}\n{sha256(canonical_request)}"
    )
    secret_date = hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = hmac_sha256(secret_date, "dnspod")
    secret_signing = hmac_sha256(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    authorization = (
        "TC3-HMAC-SHA256 "
        f"Credential={secret_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    request = urllib.request.Request(
        f"https://{API_HOST}",
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": authorization,
            "Content-Type": CONTENT_TYPE,
            "Host": API_HOST,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": API_VERSION,
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)["Response"]
    if "Error" in result:
        error = result["Error"]
        raise RuntimeError(f"{error.get('Code')}: {error.get('Message')}")
    return result


def challenge_name(domain: str) -> str:
    if domain == ZONE:
        return "_acme-challenge"
    suffix = "." + ZONE
    if not domain.endswith(suffix):
        raise RuntimeError(f"{domain} is outside DNS zone {ZONE}")
    relative = domain[: -len(suffix)]
    return f"_acme-challenge.{relative}"


def state_file(domain: str, validation: str) -> Path:
    digest = hashlib.sha256(f"{domain}\0{validation}".encode("utf-8")).hexdigest()
    return STATE_DIR / f"{digest}.json"


def find_record(name: str, validation: str) -> int | None:
    try:
        result = call_api(
            "DescribeRecordList",
            {
                "Domain": ZONE,
                "Subdomain": name,
                "RecordType": "TXT",
                "Limit": 100,
            },
        )
    except RuntimeError as error:
        if str(error).startswith("ResourceNotFound.NoDataOfRecord:"):
            return None
        raise
    for record in result.get("RecordList", []):
        if record.get("Value") == validation:
            return int(record["RecordId"])
    return None


def wait_for_dns(name: str, validation: str) -> None:
    fqdn = f"{name}.{ZONE}"
    nameservers = ("kangaroo.dnspod.net", "vanessa.dnspod.net")
    for _ in range(30):
        resolved = []
        for nameserver in nameservers:
            result = subprocess.run(
                ["dig", "+short", "TXT", fqdn, f"@{nameserver}"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            resolved.append(validation in result.stdout)
        if all(resolved):
            return
        time.sleep(4)
    raise RuntimeError(f"TXT record for {fqdn} did not reach authoritative DNS")


def authorize(domain: str, validation: str) -> None:
    name = challenge_name(domain)
    record_id = find_record(name, validation)
    if record_id is None:
        result = call_api(
            "CreateRecord",
            {
                "Domain": ZONE,
                "SubDomain": name,
                "RecordType": "TXT",
                "RecordLine": "默认",
                "Value": validation,
                "TTL": 600,
            },
        )
        record_id = int(result["RecordId"])
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file(domain, validation).write_text(
        json.dumps({"record_id": record_id}), encoding="utf-8"
    )
    wait_for_dns(name, validation)
    print(f"DNS challenge ready for {domain}")


def cleanup(domain: str, validation: str) -> None:
    path = state_file(domain, validation)
    if not path.exists():
        return
    record_id = int(json.loads(path.read_text(encoding="utf-8"))["record_id"])
    call_api("DeleteRecord", {"Domain": ZONE, "RecordId": record_id})
    path.unlink(missing_ok=True)
    print(f"DNS challenge removed for {domain}")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"auth", "cleanup"}:
        raise SystemExit("usage: certbot-dnspod-hook.py auth|cleanup")
    domain = os.environ["CERTBOT_DOMAIN"]
    validation = os.environ["CERTBOT_VALIDATION"]
    if sys.argv[1] == "auth":
        authorize(domain, validation)
    else:
        cleanup(domain, validation)


if __name__ == "__main__":
    main()
