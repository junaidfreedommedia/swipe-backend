import React,{ useEffect, useState } from "react";
import {
  Page,
  Layout,
  EmptyState,
  SkeletonBodyText,
  LegacyCard,
} from "@shopify/polaris";
import { TitleBar, Loading } from "@shopify/app-bridge-react";
import { useAuthenticatedFetch } from "./../hooks";

export default function HomePage() {
  // useEffect(() => {
  //   window.open("https://postprotect.com/", "_top")
  // },[])
  const [isLoading, setLoading] = useState(true);
  const [merchant, setMerchant] = useState(null);
  const fetch = useAuthenticatedFetch();
  let url = "https://swipe.ai/dashboard";
  let content = "Go to Dashboard";
useEffect(() => {
  const fetchMerchant = async () => {
    try {
      let merchantInfo = await (await fetch("/api/app-status")).json();
      if (!merchantInfo.installed) {
        merchantInfo = await (await fetch("/api/app-install")).json();
      }
      setMerchant(merchantInfo);
    } catch (err) {
      console.log({ err });
    } finally {
      setLoading(false);
    }
  };
  fetchMerchant();
}, []);

if(!isLoading && !merchant?.registered){
    url = `https://swipe.ai/register?token=${merchant?.token}`;
    content = "Register User"
  }
  const loadingMarkup = isLoading ? (
    <LegacyCard sectioned>
      <Loading />
      <SkeletonBodyText />
    </LegacyCard>
  ) : null;
  const emptyStateMarkup =
  !isLoading ? (
    <LegacyCard sectioned>
      <EmptyState
        heading="Go to Merchant Dashboard"
        action={{
          external: true,
          target: '_top',
          content,          
          url
        }}
      >
        <p>
          Swipe weathers any storm your package may meet. Leave the stress to us!
        </p>
      </EmptyState>
    </LegacyCard>
  ) : null;
  
  return (
    <Page>
      <TitleBar
        title="Swipe"
      />
      <Layout>
        <Layout.Section>
          {loadingMarkup}
          {emptyStateMarkup}
        </Layout.Section>
      </Layout>
    </Page>
  );
}