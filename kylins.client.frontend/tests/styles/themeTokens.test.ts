import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('theme token alignment', () => {
  const themeCss = readFileSync(resolve(__dirname, '../../src/styles/theme.css'), 'utf8');
  const tokensCss = readFileSync(resolve(__dirname, '../../../assets/design-tokens.css'), 'utf8');

  it('has matching primary colors', () => {
    expect(tokensCss).toContain('--color-primary:');
    expect(themeCss).toContain('--primary:');
  });

  it('declares all required semantic tokens', () => {
    const required = [
      '--color-background',
      '--color-foreground',
      '--color-surface',
      '--color-chrome',
      '--color-card',
      '--color-muted',
      '--color-muted-foreground',
      '--color-border',
      '--color-input',
      '--color-ring',
      '--color-primary',
      '--color-primary-foreground',
      '--color-secondary',
      '--color-secondary-foreground',
      '--color-accent',
      '--color-accent-foreground',
      '--color-destructive',
      '--color-destructive-foreground',
      '--color-success',
      '--color-success-foreground',
      '--color-warning',
      '--color-error',
      '--color-info',
      '--color-link',
      '--color-link-hover',
      '--font-ui',
      '--font-mono',
    ];
    for (const token of required) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });

  it('does not declare derivative semantic tokens missing from theme.css', () => {
    const disallowed = [
      '--color-primary-hover',
      '--color-primary-active',
      '--color-primary-light',
      '--color-primary-lighter',
      '--color-primary-dark',
      '--color-secondary-hover',
      '--color-secondary-light',
      '--color-secondary-dark',
      '--color-accent-hover',
      '--color-accent-light',
      '--color-success-light',
      '--color-warning-light',
      '--color-error-light',
      '--color-info-light',
    ];
    for (const token of disallowed) {
      expect(tokensCss).not.toContain(`${token}:`);
    }
  });

  it('declares component tokens in theme.css', () => {
    const componentTokens = [
      '--button-primary-bg',
      '--button-secondary-bg-hover',
      '--input-bg',
      '--list-row-selected-bg',
      '--ribbon-bg',
      '--statusbar-bg',
    ];
    for (const token of componentTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });
});
