// components/emails/critical-friction-alert.tsx
// React Email template for department friction threshold alerts.
// Compiled to HTML tables by @react-email/components for universal inbox support.

import * as React from 'react';
import {
  Html, Head, Body, Container, Section, Text, Heading, Hr, Link, Row, Column,
} from '@react-email/components';

interface AlertProps {
  departmentName:   string;
  shortCode:        string;
  dfi:              number;
  medianF:          number;
  ghostCount:       number;
  ghostRate:        number;
  threshold:        number;
  totalInquiries:   number;
  dashboardUrl:     string;
  triggerTimestamp: string;
}

const mono: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
};

export const CriticalFrictionAlert: React.FC<Readonly<AlertProps>> = ({
  departmentName, shortCode, dfi, medianF, ghostCount, ghostRate,
  threshold, totalInquiries, dashboardUrl, triggerTimestamp,
}) => (
  <Html lang="en">
    <Head />
    <Body style={{ backgroundColor: '#0a0a08', color: '#f0ece3', ...mono }}>
      <Container style={{ maxWidth: '580px', margin: '40px auto', padding: '0 16px' }}>

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <Section style={{ borderBottom: '3px solid #ef4444', paddingBottom: '16px', marginBottom: '24px' }}>
          <Text style={{ fontSize: '10px', letterSpacing: '0.25em', textTransform: 'uppercase', color: '#6a6050', margin: '0 0 8px' }}>
            AETHER OS · TRANSPARENCY ENGINE · AUTOMATED ALERT
          </Text>
          <Heading style={{ color: '#ef4444', fontSize: '28px', fontWeight: 900, margin: 0, letterSpacing: '-0.02em', ...mono }}>
            SYSTEMIC FAILURE<br />DETECTED
          </Heading>
        </Section>

        {/* ── ENTITY ──────────────────────────────────────────────────────── */}
        <Section style={{ background: '#111008', border: '1px solid #2a2520', padding: '20px', marginBottom: '16px' }}>
          <Text style={{ fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6a6050', margin: '0 0 6px' }}>
            ENTITY
          </Text>
          <Text style={{ fontSize: '18px', fontWeight: 700, color: '#f0ece3', margin: '0 0 4px' }}>
            {departmentName}
          </Text>
          <Text style={{ fontSize: '11px', color: '#6a6050', margin: 0 }}>
            [{shortCode}] · {totalInquiries} inquiries tracked
          </Text>
        </Section>

        {/* ── METRICS ─────────────────────────────────────────────────────── */}
        <Row style={{ marginBottom: '16px' }}>
          <Column style={{ width: '50%', paddingRight: '8px' }}>
            <Section style={{ background: '#1a0808', border: '1px solid #ef444440', padding: '16px' }}>
              <Text style={{ fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6a6050', margin: '0 0 6px' }}>
                DEPT. FRICTION INDEX
              </Text>
              <Text style={{ fontSize: '32px', fontWeight: 900, color: '#ef4444', margin: 0, lineHeight: 1 }}>
                {dfi.toFixed(1)}
              </Text>
              <Text style={{ fontSize: '10px', color: '#6a6050', margin: '4px 0 0' }}>
                threshold was {threshold}
              </Text>
            </Section>
          </Column>
          <Column style={{ width: '50%', paddingLeft: '8px' }}>
            <Section style={{ background: '#0a0a08', border: '1px solid #2a2520', padding: '16px' }}>
              <Text style={{ fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6a6050', margin: '0 0 6px' }}>
                FORMULA BREAKDOWN
              </Text>
              <Text style={{ fontSize: '13px', color: '#f0ece3', margin: '0 0 4px' }}>
                Median F: <strong style={{ color: '#fbbf24' }}>{medianF.toFixed(1)}</strong>
              </Text>
              <Text style={{ fontSize: '13px', color: '#f0ece3', margin: 0 }}>
                Ghost Rate: <strong style={{ color: '#ef4444' }}>{ghostRate.toFixed(1)}%</strong> ({ghostCount} ignored)
              </Text>
            </Section>
          </Column>
        </Row>

        {/* ── INTERPRETATION ──────────────────────────────────────────────── */}
        <Section style={{ border: '1px solid #2a2520', padding: '16px', marginBottom: '16px' }}>
          <Text style={{ fontSize: '10px', letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6a6050', margin: '0 0 8px' }}>
            DIAGNOSTIC
          </Text>
          <Text style={{ fontSize: '13px', color: '#a09080', lineHeight: 1.6, margin: 0 }}>
            {ghostCount > 0
              ? `This department has ${ghostCount} inquiry(ies) that have been ignored for more than 90 days without resolution or formal rejection. Administrative paralysis — not overt rejection — is the primary driver of the elevated DFI score.`
              : `The elevated score is driven primarily by recurring deadline misses and evasive transfers. No inquiries have crossed the 90-day ghost threshold yet, but the trajectory warrants immediate press attention.`
            }
          </Text>
        </Section>

        {/* ── ACTION ──────────────────────────────────────────────────────── */}
        <Section style={{ textAlign: 'center', marginBottom: '24px' }}>
          <Link
            href={dashboardUrl}
            style={{
              display: 'inline-block', background: '#ef4444', color: '#ffffff',
              padding: '12px 28px', textDecoration: 'none', fontWeight: 700,
              fontSize: '12px', letterSpacing: '0.15em', textTransform: 'uppercase',
            }}
          >
            VIEW FULL AUDIT TRAIL →
          </Link>
        </Section>

        <Hr style={{ borderColor: '#2a2520', margin: '0 0 16px' }} />

        {/* ── FOOTER ──────────────────────────────────────────────────────── */}
        <Text style={{ fontSize: '10px', color: '#3a3530', lineHeight: 1.6, margin: 0 }}>
          Automated alert from Aether OS Transparency Engine · {triggerTimestamp}<br />
          DFI Formula: median(F_inquiry) + ghost_rate · F = (α·Δt)¹·² + Σ(w·E) + P_status<br />
          This is a public-record notification. Citizen PII has been stripped.<br />
          Unsubscribe: reply with REMOVE in subject line.
        </Text>

      </Container>
    </Body>
  </Html>
);

export default CriticalFrictionAlert;
