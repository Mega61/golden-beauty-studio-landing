import { notFound } from "next/navigation";
import { getDictionary, hasLocale } from "./dictionaries";
import { siteConfig } from "@/config/site";
import { getActiveScenarios } from "@/data/promos";
import { getReviews } from "@/data/reviews";
import Nav from "./_components/Nav";
import Hero from "./_components/Hero";
import PromoStrip from "./_components/PromoStrip";
import Highlights from "./_components/Highlights";
import Lookbook from "./_components/Lookbook";
import Servicios from "./_components/Servicios";
import Diccionario from "./_components/Diccionario";
import Tecnicas from "./_components/Tecnicas";
import Estudio from "./_components/Estudio";
import Reviews from "./_components/Reviews";
import Contacto from "./_components/Contacto";
import Footer from "./_components/Footer";
import FloatingActions from "./_components/FloatingActions";
import BrandDivider from "./_components/BrandDivider";
import BackToTop from "./_components/BackToTop";
import JsonLd from "./_components/JsonLd";

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const typedLang = lang;
  const dict = await getDictionary(typedLang);
  const sections = siteConfig.sections;
  const scenarios = await getActiveScenarios(typedLang);
  const reviews = await getReviews(typedLang);

  return (
    <>
      <JsonLd lang={typedLang} dict={dict} />
      <PromoStrip scenarios={scenarios} dict={dict.promos} />
      <Nav lang={lang} dict={dict.nav} sections={sections} />
      <Hero dict={dict.hero} />
      <Highlights scenarios={scenarios} dict={dict.promos} />
      {sections.lookbook && <Lookbook lang={typedLang} dict={dict.lookbook} />}
      {sections.servicios && <Servicios dict={dict.servicios} lang={typedLang} />}
      {sections.servicios && sections.diccionario && <BrandDivider />}
      {sections.diccionario && <Diccionario dict={dict.diccionario} />}
      {sections.diccionario && sections.tecnicas && <BrandDivider tone="dark" />}
      {sections.tecnicas && <Tecnicas dict={dict.tecnicas} />}
      {sections.tecnicas && sections.estudio && <BrandDivider />}
      {sections.estudio && <Estudio dict={dict.estudio} />}
      {sections.reviews && <Reviews dict={dict.reviews} data={reviews} />}
      {sections.contacto && <Contacto dict={dict.contacto} />}
      <Footer dict={dict.footer} />
      <FloatingActions dict={dict.floating} />
      <BackToTop label={dict.floating.backToTop} />
    </>
  );
}
