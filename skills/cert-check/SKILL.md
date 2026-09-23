---
name: cert-check
description: 证书有效期检查与续期预案。当收到证书即将过期告警时使用。
---

# 证书检查与续期

## 适用场景
TLS 证书即将过期（通常提前 30 天告警）。

## 检查步骤（巡查员/调查员）
```bash
# 检查域名证书
openssl s_client -connect <host>:443 -servername <domain> 2>/dev/null | openssl x509 -noout -dates
# 检查本地证书文件
openssl x509 -in /etc/ssl/certs/<cert>.pem -noout -dates
```

## 处置方案（处置员提案）

### Let's Encrypt 续期（低风险）
```bash
certbot renew --quiet
```
回滚声明：证书续期不影响旧证书（覆盖前有备份）。

### 手动替换（中风险）
```bash
cp /etc/ssl/certs/<cert>.pem /etc/ssl/certs/<cert>.pem.bak
cp <new_cert> /etc/ssl/certs/<cert>.pem
systemctl reload nginx
```
回滚声明：备份在 .bak 文件，可 `cp` 回去。

## 告警指纹
- `CertExpiring*` / `TLSExpiry*`
