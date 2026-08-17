ALTER TABLE geo.publication_assisted_handoffs
  DROP CONSTRAINT publication_assisted_handoff_submit_candidate_external_ur_check;

ALTER TABLE geo.publication_assisted_handoffs
  ADD CONSTRAINT publication_assisted_handoff_submit_candidate_external_url_check
    CHECK (
      submit_candidate_external_url IS NULL OR
      (
        length(submit_candidate_external_url) BETWEEN 1 AND 2000 AND
        submit_candidate_external_url ~* '^https://([a-z0-9-]+\.)*ctrip\.com(?::443)?/[^[:space:]#]*$'
      )
    ) NOT VALID;

ALTER TABLE geo.publication_assisted_handoffs
  VALIDATE CONSTRAINT publication_assisted_handoff_submit_candidate_external_url_check;
