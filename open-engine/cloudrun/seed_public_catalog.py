import asyncio
import os

import asyncpg

DATABASE_URL = os.environ["DATABASE_URL"]

# slug, name, country code, continent, official URL, careers URL, research URL, type
INSTITUTIONS = [
    ("isprs", "ISPRS - International Society for Photogrammetry and Remote Sensing", "AT", "Europe", "https://www.isprs.org", "https://www.isprs.org/job_opportunities/default.aspx", "https://www.isprs.org/calendar/2026.aspx", "consortium"),
    ("egu", "EGU - European Geosciences Union", "DE", "Europe", "https://www.egu.eu", "https://www.egu.eu/g/jobs/", "https://www.egu.eu/g/events/", "consortium"),
    ("group-on-earth-observations", "Group on Earth Observations", "CH", "Europe", "https://earthobservations.org", "https://earthobservations.org/about-us/careers", "https://earthobservations.org/about-us/events", "consortium"),
    ("mit-eaps", "MIT Earth, Atmospheric and Planetary Sciences", "US", "North America", "https://eaps.mit.edu", "https://eaps.mit.edu/about/career-opportunities", "https://eaps.mit.edu/research", "university"),
    ("stanford-doerr-school", "Stanford Doerr School of Sustainability", "US", "North America", "https://sustainability.stanford.edu", "https://sustainability.stanford.edu/about/careers", "https://sustainability.stanford.edu/research", "university"),
    ("uc-berkeley-earth-planetary-science", "UC Berkeley Earth and Planetary Science", "US", "North America", "https://eps.berkeley.edu", "https://eps.berkeley.edu/opportunities", "https://eps.berkeley.edu/research", "university"),
    ("oxford-earth-sciences", "University of Oxford Department of Earth Sciences", "GB", "Europe", "https://www.earth.ox.ac.uk", "https://www.earth.ox.ac.uk/vacancies", "https://www.earth.ox.ac.uk/research", "university"),
    ("eth-zurich-earth-sciences", "ETH Zurich Department of Earth Sciences", "CH", "Europe", "https://erdw.ethz.ch", "https://jobs.ethz.ch", "https://erdw.ethz.ch/en/research.html", "university"),
    ("university-of-tokyo-earth-planetary-science", "University of Tokyo Department of Earth and Planetary Science", "JP", "Asia", "https://www.eps.s.u-tokyo.ac.jp", "https://www.u-tokyo.ac.jp/en/whyutokyo/careers.html", "https://www.eps.s.u-tokyo.ac.jp/en/research", "university"),
    ("cnes", "CNES - Centre National d'Études Spatiales", "FR", "Europe", "https://cnes.fr", "https://cnes.fr/en/careers", "https://cnes.fr/en/research", "government_agency"),
    ("nasa-goddard", "NASA Goddard Space Flight Center", "US", "North America", "https://www.nasa.gov/goddard", "https://www.nasa.gov/careers", "https://science.gsfc.nasa.gov", "government_agency"),
    ("european-space-agency", "European Space Agency", "FR", "Europe", "https://www.esa.int", "https://jobs.esa.int", "https://www.esa.int/Science_Exploration", "government_agency"),
    ("usgs", "U.S. Geological Survey", "US", "North America", "https://www.usgs.gov", "https://www.usgs.gov/human-capital", "https://www.usgs.gov/programs", "government_agency"),
    ("british-geological-survey", "British Geological Survey", "GB", "Europe", "https://www.bgs.ac.uk", "https://www.bgs.ac.uk/about-bgs/working-with-us/jobs", "https://www.bgs.ac.uk/geological-research", "research_institute"),
    ("cambridge-earth-sciences", "University of Cambridge Department of Earth Sciences", "GB", "Europe", "https://www.esc.cam.ac.uk", "https://www.jobs.cam.ac.uk", "https://www.esc.cam.ac.uk/research", "university"),
]


GLOBAL_SOURCES = [
    ("https://euraxess.ec.europa.eu/jobs/search", "EURAXESS research jobs", "EURAXESS", "careers_page", "vacancies", 2),
    ("https://www.isprs.org/calendar/2026.aspx", "ISPRS events 2026", "ISPRS", "institution", "events", 2),
    ("https://www.isprs.org/calendar/2027.aspx", "ISPRS events 2027", "ISPRS", "institution", "events", 2),
    ("https://www.isprs.org/job_opportunities/default.aspx", "ISPRS job opportunities", "ISPRS", "careers_page", "vacancies", 2),
    ("https://www.egu.eu/g/jobs/", "EGU jobs", "EGU", "careers_page", "vacancies", 2),
    ("https://earthobservations.org/about-us/events", "GEO events", "Group on Earth Observations", "institution", "events", 2),
    ("https://www.egu.eu/g/events/", "EGU events", "EGU", "institution", "events", 2),
]

def source_rows(row):
    _, name, _, _, official_url, careers_url, research_url, _ = row
    return [
        (official_url, name, "institution", "institution", 3),
        (careers_url, f"{name} careers", "careers_page", "vacancies", 1),
        (research_url, f"{name} research", "institution", "research", 2),
    ]


async def main() -> None:
    conn = await asyncpg.connect(
        DATABASE_URL,
        command_timeout=90,
        server_settings={"search_path": "public,extensions"},
    )
    institutions = sources = fetch_queued = promote_queued = 0
    try:
        async with conn.transaction():
            for url, name, organization, source_type, category, priority in GLOBAL_SOURCES:
                source_id = await conn.fetchval(
                    """
                    INSERT INTO public.sources(
                        url,canonical_url,name,organization,source_type,adapter_key,
                        trust_level,refresh_frequency_hours,institution_id,category,
                        priority,status,active,notes)
                    VALUES($1,$1,$2,$3,$4::public.source_type,'html-generic',5,24,
                           NULL,$5,$6,'PENDING',true,
                           'Seeded global authoritative source')
                    ON CONFLICT(url) DO UPDATE SET
                        name=excluded.name, organization=excluded.organization,
                        category=excluded.category, priority=excluded.priority,
                        active=true, status='PENDING', updated_at=now()
                    RETURNING id
                    """,
                    url, name, organization, source_type, category, priority,
                )
                sources += 1
                queued = await conn.fetchval(
                    """
                    INSERT INTO public.ingestion_tasks(task_type,source_id,payload)
                    SELECT 'FETCH',$1,jsonb_build_object('seed',true,'global_source',true)
                    WHERE NOT EXISTS (
                        SELECT 1 FROM public.ingestion_tasks
                        WHERE task_type='FETCH' AND source_id=$1
                          AND status IN ('QUEUED','PROCESSING','RETRY'))
                    RETURNING id
                    """,
                    source_id,
                )
                if queued:
                    fetch_queued += 1

            for row in INSTITUTIONS:
                slug, name, country_code, continent, official_url, careers_url, research_url, institution_type = row
                institution_id = await conn.fetchval(
                    """
                    INSERT INTO public.institutions(
                        slug,name,country_code,continent,official_url,careers_url,
                        research_url,institution_type,active,verification_status,
                        last_verified_at,is_demo)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8::public.institution_type,
                           true,'auto_discovered',now(),false)
                    ON CONFLICT(slug) DO UPDATE SET
                        name=excluded.name, country_code=excluded.country_code,
                        continent=excluded.continent, official_url=excluded.official_url,
                        careers_url=excluded.careers_url, research_url=excluded.research_url,
                        institution_type=excluded.institution_type, active=true,
                        verification_status=CASE
                          WHEN public.institutions.verification_status='verified'
                          THEN public.institutions.verification_status
                          ELSE 'auto_discovered'::public.verification_status END,
                        is_demo=false, updated_at=now()
                    RETURNING id
                    """,
                    slug, name, country_code, continent, official_url,
                    careers_url, research_url, institution_type,
                )
                institutions += 1

                for url, source_name, source_type, category, priority in source_rows(row):
                    source_id = await conn.fetchval(
                        """
                        INSERT INTO public.sources(
                            url,canonical_url,name,organization,source_type,adapter_key,
                            trust_level,refresh_frequency_hours,institution_id,category,
                            priority,status,active,notes)
                        VALUES($1,$1,$2,$3,$4::public.source_type,'html-generic',5,168,
                               $5,$6,$7,'PENDING',true,
                               'Seeded by GeoAcademic production workflow')
                        ON CONFLICT(url) DO UPDATE SET
                            name=excluded.name, organization=excluded.organization,
                            institution_id=excluded.institution_id,
                            category=excluded.category, priority=excluded.priority,
                            active=true, updated_at=now()
                        RETURNING id
                        """,
                        url, source_name, name, source_type,
                        institution_id, category, priority,
                    )
                    sources += 1
                    queued = await conn.fetchval(
                        """
                        INSERT INTO public.ingestion_tasks(
                            task_type,source_id,institution_id,payload)
                        SELECT 'FETCH',$1,$2,jsonb_build_object('seed',true)
                        WHERE NOT EXISTS (
                            SELECT 1 FROM public.ingestion_tasks
                            WHERE task_type='FETCH' AND source_id=$1
                              AND status IN ('QUEUED','PROCESSING','RETRY'))
                        RETURNING id
                        """,
                        source_id, institution_id,
                    )
                    if queued:
                        fetch_queued += 1

                promoted = await conn.fetchval(
                    """
                    INSERT INTO public.ingestion_tasks(
                        task_type,institution_id,payload)
                    SELECT 'PROMOTE_INSTITUTION',$1,jsonb_build_object('seed',true)
                    WHERE NOT EXISTS (
                        SELECT 1 FROM public.ingestion_tasks
                        WHERE task_type='PROMOTE_INSTITUTION' AND institution_id=$1
                          AND status IN ('QUEUED','PROCESSING','RETRY'))
                    RETURNING id
                    """,
                    institution_id,
                )
                if promoted:
                    promote_queued += 1

        public_count = await conn.fetchval(
            """SELECT count(*) FROM public.institutions
               WHERE is_demo=false AND verification_status IN
               ('verified','auto_discovered','possibly_outdated')"""
        )
        print(
            "PUBLIC_SEED_OK "
            f"institutions={institutions} sources={sources} "
            f"fetch_queued={fetch_queued} promote_queued={promote_queued} "
            f"public_institutions={public_count}"
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
