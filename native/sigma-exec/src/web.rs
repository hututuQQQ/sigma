use crate::process::BrokerState;
use crate::protocol::RpcError;
use base64::Engine;
use reqwest::Url;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::str::FromStr;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const HARD_TIMEOUT_MS: u64 = 60_000;
const MAX_REDIRECTS: usize = 5;
const EXA_HOST: &str = "mcp.exa.ai";
const EXA_PATH: &str = "/mcp";
const EXA_ADVANCED_QUERY: &str = "tools=web_search_advanced_exa";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WebNetworkTarget {
    origin: String,
    method: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WebRequestParams {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body_base64: String,
    network_targets: Vec<WebNetworkTarget>,
    network_approved: bool,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_response_limit")]
    max_response_bytes: usize,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_response_limit() -> usize {
    MAX_RESPONSE_BYTES
}

fn policy_error(message: impl Into<String>) -> RpcError {
    RpcError::new("policy_denied", message)
}

fn protocol_error(message: impl Into<String>) -> RpcError {
    RpcError::new("broker_protocol_error", message)
}

fn request_error(message: impl Into<String>) -> RpcError {
    RpcError::new("web_request_failed", message)
}

fn cancelled_error() -> RpcError {
    RpcError::new("cancelled", "Web request was cancelled")
}

fn parse_url(value: &str) -> Result<Url, RpcError> {
    let url = Url::parse(value).map_err(|_| policy_error("Web URL must be absolute"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(policy_error(
            "Web URL must use HTTP(S) without credentials or a fragment",
        ));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| policy_error("Web URL port is invalid"))?;
    if !matches!(port, 80 | 443) {
        return Err(policy_error("Web requests permit only ports 80 and 443"));
    }
    Ok(url)
}

fn canonical_origin(value: &str) -> Result<String, RpcError> {
    let url = parse_url(value)?;
    if url.path() != "/" || url.query().is_some() {
        return Err(policy_error(
            "Approved Web network targets must be canonical origins",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_hostname(host: &str) -> Result<(), RpcError> {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || (!lower.contains('.') && IpAddr::from_str(&lower).is_err())
    {
        return Err(policy_error(
            "Local and single-label Web hostnames are denied",
        ));
    }
    Ok(())
}

fn in_v4_prefix(ip: Ipv4Addr, base: [u8; 4], prefix: u32) -> bool {
    let value = u32::from(ip);
    let base = u32::from(Ipv4Addr::from(base));
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    value & mask == base & mask
}

fn public_v4(ip: Ipv4Addr) -> bool {
    ![
        ([0, 0, 0, 0], 8),
        ([10, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([127, 0, 0, 0], 8),
        ([169, 254, 0, 0], 16),
        ([172, 16, 0, 0], 12),
        ([192, 0, 0, 0], 24),
        ([192, 0, 2, 0], 24),
        ([192, 88, 99, 0], 24),
        ([192, 168, 0, 0], 16),
        ([198, 18, 0, 0], 15),
        ([198, 51, 100, 0], 24),
        ([203, 0, 113, 0], 24),
        ([224, 0, 0, 0], 4),
        ([240, 0, 0, 0], 4),
    ]
    .iter()
    .any(|(base, prefix)| in_v4_prefix(ip, *base, *prefix))
}

fn in_v6_prefix(ip: Ipv6Addr, base: [u16; 8], prefix: u32) -> bool {
    let value = u128::from(ip);
    let base = u128::from(Ipv6Addr::from(base));
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    value & mask == base & mask
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return public_v4(mapped);
    }
    in_v6_prefix(ip, [0x2000, 0, 0, 0, 0, 0, 0, 0], 3)
        && ![
            ([0x2001, 0, 0, 0, 0, 0, 0, 0], 23),
            ([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32),
            ([0x2002, 0, 0, 0, 0, 0, 0, 0], 16),
            ([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20),
            ([0x5f00, 0, 0, 0, 0, 0, 0, 0], 16),
        ]
        .iter()
        .any(|(base, prefix)| in_v6_prefix(ip, *base, *prefix))
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => public_v4(value),
        IpAddr::V6(value) => public_v6(value),
    }
}

fn resolve_public(url: &Url) -> Result<(String, SocketAddr), RpcError> {
    let host = url
        .host_str()
        .ok_or_else(|| policy_error("Web URL host is missing"))?;
    validate_hostname(host)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| policy_error("Web URL port is invalid"))?;
    let mut addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| request_error(format!("Web DNS resolution failed: {error}")))?
        .collect::<Vec<_>>();
    addresses.sort_by_key(|address| address.to_string());
    addresses.dedup();
    if addresses.is_empty() {
        return Err(request_error("Web DNS resolution returned no addresses"));
    }
    if addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(policy_error(
            "Web DNS resolution included a non-public or reserved address",
        ));
    }
    Ok((host.to_owned(), addresses[0]))
}

fn allowed_header(name: &str, provider_post: bool) -> bool {
    matches!(name, "accept" | "user-agent")
        || (provider_post
            && matches!(
                name,
                "content-type" | "mcp-protocol-version" | "mcp-session-id" | "x-api-key"
            ))
}

fn request_headers(
    values: &HashMap<String, String>,
    provider_post: bool,
) -> Result<HeaderMap, RpcError> {
    let mut output = HeaderMap::new();
    for (name, value) in values {
        if name != &name.trim().to_ascii_lowercase()
            || !allowed_header(name, provider_post)
            || value.len() > 8_192
            || value.contains(['\r', '\n', '\0'])
        {
            return Err(policy_error(format!(
                "Web request header '{name}' is not allowed"
            )));
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| policy_error("Web request header name is invalid"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| policy_error("Web request header value is invalid"))?;
        output.insert(header_name, header_value);
    }
    Ok(output)
}

fn validate_provider_post(url: &Url, method: &str) -> Result<(), RpcError> {
    if method != "POST" {
        return Ok(());
    }
    if url.scheme() != "https"
        || url.host_str() != Some(EXA_HOST)
        || url.port_or_known_default() != Some(443)
        || url.path() != EXA_PATH
        || !matches!(url.query(), None | Some(EXA_ADVANCED_QUERY))
    {
        return Err(policy_error(
            "Web POST is restricted to the fixed Exa MCP endpoint",
        ));
    }
    Ok(())
}

fn validate_approval(params: &WebRequestParams, url: &Url) -> Result<(), RpcError> {
    if !params.network_approved
        || params.network_targets.is_empty()
        || params.network_targets.len() > 8
    {
        return Err(policy_error(
            "Web request requires an exact per-call network approval",
        ));
    }
    let expected = url.origin().ascii_serialization();
    let mut matched = false;
    for target in &params.network_targets {
        if !matches!(target.method.as_str(), "GET" | "POST") {
            return Err(policy_error("Approved Web target method is invalid"));
        }
        let origin = canonical_origin(&target.origin)?;
        if origin == expected && target.method == params.method {
            matched = true;
        }
    }
    if !matched {
        return Err(policy_error(
            "Web request URL and method do not match the approved target",
        ));
    }
    Ok(())
}

fn client(host: &str, address: SocketAddr, timeout: Duration) -> Result<Client, RpcError> {
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .referer(false)
        .timeout(timeout)
        .connect_timeout(timeout);
    if IpAddr::from_str(host).is_err() {
        builder = builder.resolve(host, address);
    }
    builder
        .build()
        .map_err(|error| request_error(format!("Web client initialization failed: {error}")))
}

fn response_headers(headers: &HeaderMap) -> HashMap<String, String> {
    [
        "content-type",
        "location",
        "mcp-protocol-version",
        "mcp-session-id",
        "retry-after",
    ]
    .iter()
    .filter_map(|name| {
        headers
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .map(|value| ((*name).to_owned(), value.to_owned()))
    })
    .collect()
}

fn redirect_target(response: &Response, current: &Url) -> Result<Option<Url>, RpcError> {
    if !response.status().is_redirection() {
        return Ok(None);
    }
    let Some(location) = response.headers().get(LOCATION) else {
        return Ok(None);
    };
    let location = location
        .to_str()
        .map_err(|_| request_error("Web redirect location is not valid UTF-8"))?;
    let target = current
        .join(location)
        .map_err(|_| request_error("Web redirect location is invalid"))?;
    parse_url(target.as_str()).map(Some)
}

fn read_body(
    state: &BrokerState,
    request_id: u64,
    mut response: Response,
    maximum: usize,
) -> Result<Vec<u8>, RpcError> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        if state.request_cancelled(request_id) {
            return Err(cancelled_error());
        }
        let count = response
            .read(&mut chunk)
            .map_err(|error| request_error(format!("Web response read failed: {error}")))?;
        if count == 0 {
            break;
        }
        if output.len().saturating_add(count) > maximum {
            return Err(policy_error(
                "Web response exceeds the decompressed response limit",
            ));
        }
        output.extend_from_slice(&chunk[..count]);
    }
    state.redact_external_bytes(&output)
}

fn send(
    client: &Client,
    url: &Url,
    method: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response, RpcError> {
    let builder = if method == "GET" {
        client.get(url.clone())
    } else {
        client.post(url.clone()).body(body.to_vec())
    };
    builder
        .headers(headers.clone())
        .send()
        .map_err(|error| request_error(format!("Web request failed: {error}")))
}

fn response_value(
    state: &BrokerState,
    request_id: u64,
    response: Response,
    current: &Url,
    redirect_url: Option<String>,
    maximum: usize,
) -> Result<Value, RpcError> {
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    let body = if redirect_url.is_some() {
        Vec::new()
    } else {
        read_body(state, request_id, response, maximum)?
    };
    Ok(json!({
        "status": status,
        "finalUrl": current.as_str(),
        "headers": headers,
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(body),
        "redirectUrl": redirect_url,
        "truncated": false,
        "redacted": true,
    }))
}

pub(crate) fn request(
    state: &BrokerState,
    request_id: u64,
    params: WebRequestParams,
) -> Result<Value, RpcError> {
    if !matches!(params.method.as_str(), "GET" | "POST") {
        return Err(policy_error("Web request method must be GET or POST"));
    }
    if params.timeout_ms == 0
        || params.timeout_ms > HARD_TIMEOUT_MS
        || params.max_response_bytes == 0
        || params.max_response_bytes > MAX_RESPONSE_BYTES
    {
        return Err(policy_error(
            "Web request timeout or response limit is invalid",
        ));
    }
    let body = base64::engine::general_purpose::STANDARD
        .decode(&params.body_base64)
        .map_err(|_| protocol_error("Web request bodyBase64 is invalid"))?;
    if body.len() > MAX_REQUEST_BYTES || (params.method == "GET" && !body.is_empty()) {
        return Err(policy_error(
            "Web request body is not allowed or exceeds 256 KiB",
        ));
    }
    let mut current = parse_url(&params.url)?;
    validate_provider_post(&current, &params.method)?;
    validate_approval(&params, &current)?;
    let provider_post = params.method == "POST";
    let request_headers = request_headers(&params.headers, provider_post)?;
    let (host, address) = resolve_public(&current)?;
    let timeout = Duration::from_millis(params.timeout_ms);
    let client = client(&host, address, timeout)?;
    let approved_origin = current.origin().ascii_serialization();
    for redirect_count in 0..=MAX_REDIRECTS {
        if state.request_cancelled(request_id) {
            return Err(cancelled_error());
        }
        let response = send(&client, &current, &params.method, &request_headers, &body)?;
        let redirect = redirect_target(&response, &current)?;
        let Some(target) = redirect else {
            return response_value(
                state,
                request_id,
                response,
                &current,
                None,
                params.max_response_bytes,
            );
        };
        if params.method == "POST" {
            validate_provider_post(&target, &params.method)?;
        }
        let same_origin = target.origin().ascii_serialization() == approved_origin;
        let preserves_method =
            matches!(response.status().as_u16(), 307 | 308) || params.method == "GET";
        if !same_origin || !preserves_method {
            return response_value(
                state,
                request_id,
                response,
                &current,
                Some(target.into()),
                params.max_response_bytes,
            );
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(request_error("Web request exceeded five redirects"));
        }
        current = target;
    }
    Err(request_error("Web redirect state is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approved_params(url: &str, method: &str, origin: &str) -> WebRequestParams {
        WebRequestParams {
            url: url.to_owned(),
            method: method.to_owned(),
            headers: HashMap::new(),
            body_base64: String::new(),
            network_targets: vec![WebNetworkTarget {
                origin: origin.to_owned(),
                method: method.to_owned(),
            }],
            network_approved: true,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_response_bytes: MAX_RESPONSE_BYTES,
        }
    }

    #[test]
    fn rejects_non_public_ipv4_ranges() {
        for value in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!public_ip(IpAddr::V4(value.parse().unwrap())), "{value}");
        }
        assert!(public_ip(IpAddr::V4("93.184.216.34".parse().unwrap())));
    }

    #[test]
    fn rejects_private_and_transition_ipv6_ranges() {
        for value in [
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:2::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "5f00::1",
        ] {
            assert!(!public_ip(IpAddr::V6(value.parse().unwrap())), "{value}");
        }
        assert!(public_ip(IpAddr::V6(
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()
        )));
    }

    #[test]
    fn provider_post_is_fixed_to_exa_mcp() {
        assert!(
            validate_provider_post(&parse_url("https://mcp.exa.ai/mcp").unwrap(), "POST").is_ok()
        );
        assert!(
            validate_provider_post(
                &parse_url("https://mcp.exa.ai/mcp?tools=web_search_advanced_exa").unwrap(),
                "POST"
            )
            .is_ok()
        );
        assert!(
            validate_provider_post(
                &parse_url("https://mcp.exa.ai/mcp?tools=web_search_exa").unwrap(),
                "POST"
            )
            .is_err()
        );
        assert!(
            validate_provider_post(&parse_url("https://mcp.exa.ai/other").unwrap(), "POST")
                .is_err()
        );
        assert!(
            validate_provider_post(&parse_url("https://example.com/mcp").unwrap(), "POST").is_err()
        );
    }

    #[test]
    fn local_names_and_disallowed_ports_are_rejected() {
        assert!(validate_hostname("localhost").is_err());
        assert!(validate_hostname("printer").is_err());
        assert!(validate_hostname("service.local").is_err());
        assert!(parse_url("https://example.com:8443/").is_err());
        assert!(parse_url("https://user@example.com/").is_err());
        assert!(parse_url("https://example.com/#fragment").is_err());
    }

    #[test]
    fn approval_is_bound_to_the_exact_method_and_origin() {
        let url = parse_url("https://example.com/article").unwrap();
        let approved = approved_params("https://example.com/article", "GET", "https://example.com");
        assert!(validate_approval(&approved, &url).is_ok());

        let wrong_method =
            approved_params("https://example.com/article", "GET", "https://example.com");
        let mut wrong_method = wrong_method;
        wrong_method.network_targets[0].method = "POST".to_owned();
        assert!(validate_approval(&wrong_method, &url).is_err());

        let wrong_origin = approved_params(
            "https://example.com/article",
            "GET",
            "https://other.example",
        );
        assert!(validate_approval(&wrong_origin, &url).is_err());

        let mut unapproved = approved;
        unapproved.network_approved = false;
        assert!(validate_approval(&unapproved, &url).is_err());
    }

    #[test]
    fn page_requests_cannot_forward_provider_or_ambient_auth_headers() {
        let mut values = HashMap::new();
        values.insert("accept".to_owned(), "text/html".to_owned());
        values.insert("user-agent".to_owned(), "Sigma-Code-Web/1".to_owned());
        assert!(request_headers(&values, false).is_ok());

        values.insert("x-api-key".to_owned(), "secret".to_owned());
        assert!(request_headers(&values, false).is_err());
        assert!(request_headers(&values, true).is_ok());

        values.remove("x-api-key");
        values.insert("cookie".to_owned(), "session=secret".to_owned());
        assert!(request_headers(&values, true).is_err());

        values.remove("cookie");
        values.insert("accept".to_owned(), "text/html\r\nx-forged: yes".to_owned());
        assert!(request_headers(&values, false).is_err());
    }
}
