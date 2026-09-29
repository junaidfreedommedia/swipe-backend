import { useState, useEffect } from "react";
import {  Spinner, Button,  } from "@shopify/polaris";
import { Toast } from "@shopify/app-bridge-react";
import { useAppQuery, useAuthenticatedFetch } from "../hooks";


export function ProductsCard() {
    const [isLoading, setIsLoading] = useState(true);
    const [merchant, setMerchant] = useState(null);
    const fetch = useAuthenticatedFetch();
    useEffect(async () => {
        try{
            let merchantInfo = await (await fetch("/api/app-status")).json();
            if(!merchantInfo.installed) {
                merchantInfo = await (await fetch("/api/app-install")).json();
            }
            setMerchant(merchantInfo);
        }catch(err){
            console.log({err});
        }
        setIsLoading(false);
    }, []);
    if (isLoading) return <Spinner accessibilityLabel="Spinner example" size="large" />;
    let url = "https://swipe.ai";
    let content = "Go to Dashboard";
    if(!merchant?.registered){
        url = `${url}/register?token=${merchant?.token}`;
        content = "Register Merchant User"
    }
    return (
        <Button
            url={url}
            external
        >
            {content}
        </Button>
    );
}
