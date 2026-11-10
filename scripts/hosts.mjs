import { createHash } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const usage = `Manage the SSH host registry in a local Wrangler configuration.

  npm run hosts -- list
  npm run hosts -- register <hostname> --user <user> --tunnel-id <uuid> --host-key <SHA256:fingerprint> --secret <secret-name> [--default] [--replace]
  npm run hosts -- remove <hostname> [--default-host <remaining-hostname>]

Options: --config <file> (default: wrangler.local.jsonc)
Provision the named Worker secret with wrangler secret put before deployment.
Run npm run deploy after changing the registry to apply it to the MCP server.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'wrangler.local.jsonc' },
      user: { type: 'string' },
      'tunnel-id': { type: 'string' },
      'host-key': { type: 'string' },
      secret: { type: 'string' },
      default: { type: 'boolean' },
      replace: { type: 'boolean' },
      'default-host': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    console.log(usage);
    return;
  }
  const [command, inputHost] = positionals;
  if (!['list', 'register', 'remove'].includes(command) || positionals.length > 2) {
    throw new Error(usage);
  }
  const configPath = resolve(values.config);
  const lockPath = `${configPath}.hosts.lock`;
  const lock = command === 'list' ? undefined : await open(lockPath, 'wx', 0o600);
  try {
    const original = await readFile(configPath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(configPath, original);
    if (parsed.error) throw new Error('Cannot parse Wrangler configuration');
    const config = parsed.config;
    config.vars ??= {};
    const hosts = config.vars.SSH_HOSTS ?? {};
    if (command === 'list') {
      console.log(JSON.stringify({
        hosts,
        defaultHost: config.vars.SSH_DEFAULT_HOST ?? null,
      }, null, 2));
      return;
    }
    const host = inputHost?.toLowerCase();
    if (!host || host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('Provide a valid registered hostname');
    }
    const previous = Object.hasOwn(hosts, host) ? hosts[host] : undefined;
    if (command === 'register') {
      if (!values.user || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values['tunnel-id'] ?? '')) {
        throw new Error('Registration requires --user and a valid --tunnel-id');
      }
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(values['host-key'] ?? '') || !/^[A-Z][A-Z0-9_]*$/.test(values.secret ?? '')) {
        throw new Error('Registration requires a verified --host-key and a --secret binding name');
      }
      config.vpc_networks ??= [];
      const existingBinding = config.vpc_networks.find(binding => binding.tunnel_id === values['tunnel-id']);
      const bindingId = createHash('sha256').update(`${host}:${values['tunnel-id']}`).digest('hex').slice(0, 16).toUpperCase();
      const binding = existingBinding?.binding ?? `SSH_HOST_${bindingId}`;
      const registration = { binding, username: values.user, hostKey: values['host-key'], privateKeySecret: values.secret };
      if (previous && Object.entries(registration).some(([key, value]) => previous[key] !== value) && !values.replace) {
        throw new Error('Host already registered with different settings; use --replace to update it');
      }
      const conflict = config.vpc_networks.find(entry => entry.binding === binding && entry.tunnel_id !== values['tunnel-id']);
      if (conflict) throw new Error('VPC binding name conflicts with another tunnel');
      if (!existingBinding) {
        config.vpc_networks.push({ binding, tunnel_id: values['tunnel-id'], remote: true });
      }
      hosts[host] = registration;
      if (values.default || !config.vars.SSH_DEFAULT_HOST) config.vars.SSH_DEFAULT_HOST = host;
    } else {
      if (!Object.hasOwn(hosts, host)) throw new Error('Host is not registered');
      if (config.vars.SSH_DEFAULT_HOST === host) {
        const replacement = values['default-host']?.toLowerCase();
        if ((Object.keys(hosts).length > 1 && !replacement) || (replacement && (replacement === host || !Object.hasOwn(hosts, replacement)))) {
          throw new Error('Removing the default host requires --default-host naming a remaining registered host');
        }
        config.vars.SSH_DEFAULT_HOST = replacement;
      }
      delete hosts[host];
    }
    config.vars.SSH_HOSTS = hosts;
    // Preserve bindings and secrets that may also serve legacy callers or other hosts.
    if (await readFile(configPath, 'utf8') !== original) {
      throw new Error('Configuration changed during registration; inspect it and try again');
    }
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, configPath);
    console.log(`${command === 'register' ? 'Registered' : 'Removed'} ${host}. Deploy the configuration to apply this change.`);
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
