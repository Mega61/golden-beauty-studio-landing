import { notFound } from "next/navigation";
import { getDictionary, hasLocale } from "./dictionaries";
import { siteConfig } from "@/config/site";
import { getActiveScenario } from "@/data/promos";
import Nav from "./_components/Nav";
import Hero from "./_components/Hero";
import PromoStrip from "./_components/PromoStrip";
import Highlights from "./_components/Highlights";
import Lookbook from "./_components/Lookbook";
import Servicios from "./_components/Servicios";
import Diccionario from "./_components/Diccionario";
import Tecnicas from "./_components/Tecnicas";
import Estudio from "./_components/Estudio";
import Contacto from "./_components/Contacto";
import Footer from "./_components/Footer";
import FloatingActions from "./_components/FloatingActions";
import BrandDivider from "./_components/BrandDivider";
import BackToTop from "./_components/BackToTop";

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
  const scenario = await getActiveScenario(typedLang);

  return (
    <>
      <PromoStrip scenario={scenario} dict={dict.promos} />
      <Nav lang={lang} dict={dict.nav} sections={sections} />
      <Hero dict={dict.hero} />
      <Highlights scenario={scenario} dict={dict.promos} />
      {sections.lookbook && <Lookbook lang={typedLang} dict={dict.lookbook} />}
      {sections.servicios && <Servicios dict={dict.servicios} lang={typedLang} />}
      {sections.servicios && sections.diccionario && <BrandDivider />}
      {sections.diccionario && <Diccionario dict={dict.diccionario} />}
      {sections.diccionario && sections.tecnicas && <BrandDivider tone="dark" />}
      {sections.tecnicas && <Tecnicas dict={dict.tecnicas} />}
      {sections.tecnicas && sections.estudio && <BrandDivider />}
      {sections.estudio && <Estudio dict={dict.estudio} />}
      {sections.contacto && <Contacto dict={dict.contacto} />}
      <Footer dict={dict.footer} />
      <FloatingActions dict={dict.floating} />
      <BackToTop />
    </>
  );
}
