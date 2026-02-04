# Security Policy

## Supported Versions

The following versions of mcp-trunc-proxy are currently supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :x:                |
| < 0.1   | :x:                |

## Security Considerations

This proxy handles MCP tool outputs which may contain sensitive data. Please note:

- **Memory Store (default)**: Artifacts are stored in process memory and cleared on restart
- **File Store**: Artifacts are written to disk - ensure appropriate file permissions
- **Redis Store**: Credentials are masked in logs, but ensure Redis is properly secured

### Best Practices

1. Use memory store for sensitive data when possible
2. Set appropriate `--ttl` values to limit artifact lifetime
3. For Redis, use TLS and authentication
4. Review artifacts before sharing debug output

## Reporting a Vulnerability

If you discover a security vulnerability in mcp-trunc-proxy, please report it responsibly:

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email the maintainer directly at the address listed in package.json
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### Response Timeline

- **Initial response**: Within 48 hours
- **Status update**: Within 7 days
- **Fix timeline**: Depends on severity
  - Critical: 24-72 hours
  - High: 1-2 weeks
  - Medium/Low: Next release cycle

### After Reporting

- You will receive acknowledgment of your report
- We will investigate and keep you informed of progress
- Once fixed, we will publicly credit you (unless you prefer anonymity)
- We follow responsible disclosure practices

## Security Features

- Path traversal prevention in file store
- Base64 validation before decode
- Redis credential masking in logs
- Graceful handling of corrupt artifacts
- No external network calls (fully offline)
